import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { Settings } from '@shared/types';

export type ProbeResult = { live: true; streamId: string; qualities: string[] } | { live: false; reason: string };

export interface CaptureProcs {
  /** Fires once, when either process exits. */
  onExit(cb: (reason: string) => void): void;
  stop(): Promise<void>;
  /** 16 kHz mono s16le audio from FFmpeg stdout; null when the tap is off. */
  pcm: Readable | null;
}

export interface CaptureOptions {
  quality: string;
  pcm: boolean;
}

export type RunnerSettings = Pick<Settings, 'streamlinkPath' | 'ffmpegPath' | 'segmentSeconds'>;

export interface ProcessRunner {
  probe(channel: string): Promise<ProbeResult>;
  /** Returns a human-readable error, or null when both binaries are runnable. */
  checkBinaries(): Promise<string | null>;
  spawnCapture(channel: string, epochDir: string, opts: CaptureOptions): CaptureProcs;
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

export function ffmpegSegmentArgs(epochDir: string, segmentSeconds: number, pcm: boolean): string[] {
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-segment_format', 'mpegts', '-reset_timestamps', '0',
    '-segment_list', join(epochDir, 'segments.csv'), '-segment_list_type', 'csv',
    join(epochDir, 'seg_%06d.ts'),
  ];
  // PCM output only (its options follow its own -map): s16le has no timestamps, so the byte clock must
  // follow them — aresample fills gaps in the audio timestamps with silence (async=1) and starts at t=0
  // like the segment timeline (first_pts=0). The video is still only copied.
  if (pcm) args.push('-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1');
  return args;
}

/** Interprets the output of `streamlink --json <url>`. */
export function parseProbeOutput(stdout: string): ProbeResult {
  let data: { error?: unknown; metadata?: { id?: unknown }; streams?: unknown };
  try {
    data = JSON.parse(stdout);
  } catch {
    return { live: false, reason: 'streamlink вернул неожиданный ответ' };
  }
  if (!data || typeof data !== 'object') return { live: false, reason: 'streamlink вернул неожиданный ответ' };
  if (data.error) return { live: false, reason: String(data.error) };
  const id = data.metadata?.id;
  const names = data.streams && typeof data.streams === 'object' ? Object.keys(data.streams) : [];
  const qualities = ['best', ...names.filter((n) => n !== 'best')];
  return { live: true, streamId: id === undefined || id === null || id === '' ? 'unknown' : String(id), qualities };
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), error: (error as NodeJS.ErrnoException) ?? undefined });
    });
  });
}

const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

export function createProcessRunner(getSettings: () => RunnerSettings): ProcessRunner {
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

    spawnCapture(channel, epochDir, opts) {
      const s = getSettings();
      const streamlink = spawn(s.streamlinkPath, streamlinkArgs(channel, opts.quality), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpeg = spawn(s.ffmpegPath, ffmpegSegmentArgs(epochDir, s.segmentSeconds, opts.pcm), { windowsHide: true, stdio: ['pipe', opts.pcm ? 'pipe' : 'ignore', 'pipe'] });
      // Keep the last line each process printed: it is the only explanation the user gets when capture dies.
      const lastLine = { streamlink: '', ffmpeg: '' };
      const follow = (name: keyof typeof lastLine, child: ChildProcess) => {
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          const line = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
          if (line) lastLine[name] = line.slice(0, 300);
        });
        child.stderr?.on('error', () => undefined);
      };
      follow('streamlink', streamlink);
      follow('ffmpeg', ffmpeg);
      const why = (name: keyof typeof lastLine) => (lastLine[name] ? `: ${lastLine[name]}` : '');
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
      // 'close' (not 'exit') so that everything the process wrote to stderr has been read.
      streamlink.on('close', (code) => report(`streamlink завершился (код ${code})${why('streamlink')}`));
      ffmpeg.on('close', (code) => report(`ffmpeg завершился (код ${code})${why('ffmpeg')}`));

      return {
        pcm: opts.pcm ? ffmpeg.stdout : null,
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
