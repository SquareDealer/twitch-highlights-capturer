import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n: number) => String(n).padStart(2, '0');

/** Appends one JSON line to <dataDir>/nearmiss/<channel>/<YYYY-MM-DD>.jsonl (local date). */
export function appendNearMiss(dataDir: string, channel: string, entry: object): void {
  const d = new Date();
  const dir = join(dataDir, 'nearmiss', channel);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
}
