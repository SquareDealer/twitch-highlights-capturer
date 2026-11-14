import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

export const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Unique temp directory, removed after the current test. */
export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'thr-'));
  created.push(d);
  return d;
}

/** Container duration in seconds, via ffprobe. */
export function probeDurationSec(file: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(String(r.stdout).trim());
}

/** Generates a test video with FFmpeg's lavfi sources; `extra` are the output options and target. */
export function synthVideo(seconds: number, extra: string[]): void {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=d=${seconds}:r=30:s=320x240`, '-f', 'lavfi', '-i', `sine=d=${seconds}`,
    '-g', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}
