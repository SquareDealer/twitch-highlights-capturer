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
