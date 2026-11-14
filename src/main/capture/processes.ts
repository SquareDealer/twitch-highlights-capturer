import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Settings } from '@shared/types';

export type ProbeResult = { live: true; streamId: string } | { live: false; reason: string };

export interface CaptureProcs {
  /** Fires once, when either process exits. */
  onExit(cb: (reason: string) => void): void;
  stop(): Promise<void>;
}

export interface ProcessRunner {
  probe(channel: string): Promise<ProbeResult>;
  /** Returns a human-readable error, or null when both binaries are runnable. */
  checkBinaries(): Promise<string | null>;
  spawnCapture(channel: string, epochDir: string): CaptureProcs;
}

/** 'https://www.twitch.tv/Foo_Bar/' → 'foo_bar'; anything that is not a Twitch login → null. */
export function normalizeChannel(input: string): string | null {
  let s = input.trim().toLowerCase();
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/(.*)$/.exec(s);
  if (url) s = url[1]!.split(/[?#]/)[0]!.replace(/\/+$/, '');
  return /^[a-z0-9_]{1,25}$/.test(s) ? s : null;
}

export function streamlinkArgs(channel: string, quality: string): string[] {
  return ['--stdout', '--twitch-low-latency', '--retry-streams', '0', `https://twitch.tv/${channel}`, quality];
}

export function ffmpegSegmentArgs(epochDir: string, segmentSeconds: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-segment_format', 'mpegts', '-reset_timestamps', '0',
    '-segment_list', join(epochDir, 'segments.csv'), '-segment_list_type', 'csv',
    join(epochDir, 'seg_%06d.ts'),
  ];
}

/** Interprets the output of `streamlink --json <url>`. */
export function parseProbeOutput(stdout: string): ProbeResult {
  let data: { error?: unknown; metadata?: { id?: unknown } };
  try {
    data = JSON.parse(stdout);
  } catch {
    return { live: false, reason: 'streamlink вернул неожиданный ответ' };
  }
  if (!data || typeof data !== 'object') return { live: false, reason: 'streamlink вернул неожиданный ответ' };
  if (data.error) return { live: false, reason: String(data.error) };
  const id = data.metadata?.id;
  return { live: true, streamId: id === undefined || id === null || id === '' ? 'unknown' : String(id) };
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), error: (error as NodeJS.ErrnoException) ?? undefined });
    });
  });
}

const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

export function createProcessRunner(getSettings: () => Settings): ProcessRunner {
  return {
    async probe(channel) {
      const { stdout, error } = await run(getSettings().streamlinkPath, ['--json', `https://twitch.tv/${channel}`], 30_000);
      if (!stdout.trim()) return { live: false, reason: error?.message ?? 'streamlink не ответил' };
      return parseProbeOutput(stdout); // streamlink exits non-zero but still prints {"error": ...}
    },

    async checkBinaries() {
      const s = getSettings();
      const checks: Array<[string, string, string[]]> = [
        ['streamlink', s.streamlinkPath, ['--version']],
        ['ffmpeg', s.ffmpegPath, ['-version']],
      ];
      for (const [name, file, args] of checks) {
        const r = await run(file, args, 15_000);
        if (!r.ok) return `Не удалось запустить ${name} («${file}»). Установите его или укажите путь в настройках.`;
      }
      return null;
    },

    spawnCapture(channel, epochDir) {
      const s = getSettings();
      const streamlink = spawn(s.streamlinkPath, streamlinkArgs(channel, s.quality), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const ffmpeg = spawn(s.ffmpegPath, ffmpegSegmentArgs(epochDir, s.segmentSeconds), { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      streamlink.stdout!.pipe(ffmpeg.stdin!);
      // A dying peer must not crash the app with an unhandled EPIPE.
      streamlink.stdout!.on('error', () => undefined);
      ffmpeg.stdin!.on('error', () => undefined);

      let exitCb: ((reason: string) => void) | null = null;
      let pendingReason: string | null = null;
      let reported = false;
      const report = (reason: string) => {
        if (reported) return;
        reported = true;
        if (exitCb) exitCb(reason);
        else pendingReason = reason;
      };
      streamlink.on('error', (e) => report(`streamlink: ${e.message}`));
      ffmpeg.on('error', (e) => report(`ffmpeg: ${e.message}`));
      streamlink.on('exit', (code) => report(`streamlink завершился (код ${code})`));
      ffmpeg.on('exit', (code) => report(`ffmpeg завершился (код ${code})`));

      return {
        onExit(cb) {
          exitCb = cb;
          if (pendingReason !== null) cb(pendingReason);
        },
        async stop() {
          reported = true; // an intentional stop is not an "unexpected exit"
          if (!exited(streamlink)) streamlink.kill();
          if (!exited(ffmpeg)) {
            // FFmpeg finalizes the last segment once its input reaches EOF.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                if (!exited(ffmpeg)) ffmpeg.kill();
                resolve();
              }, 5000);
              ffmpeg.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
              ffmpeg.stdin?.end();
            });
          }
        },
      };
    },
  };
}
