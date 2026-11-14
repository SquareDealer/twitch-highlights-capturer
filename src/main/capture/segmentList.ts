import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface SegmentListEntry {
  file: string;
  startSec: number;
  endSec: number;
}

/** Parses one line of FFmpeg's CSV segment list: `seg_000012.ts,24.033000,26.066000`. */
export function parseSegmentLine(line: string): SegmentListEntry | null {
  const parts = line.trim().split(',');
  if (parts.length !== 3) return null;
  const [file, start, end] = parts as [string, string, string];
  if (!file || !/^-?\d+(\.\d+)?$/.test(start) || !/^-?\d+(\.\d+)?$/.test(end)) return null;
  const startSec = Number(start);
  const endSec = Number(end);
  if (endSec <= startSec) return null;
  return { file, startSec, endSec };
}

/** Follows a growing CSV segment list and reports each completed (newline-terminated) line exactly once. */
export class SegmentListTailer {
  private offset = 0;
  private pending = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly csvPath: string, private readonly onEntry: (e: SegmentListEntry) => void, private readonly intervalMs = 250) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll(): void {
    let fd: number;
    try {
      fd = openSync(this.csvPath, 'r');
    } catch {
      return; // not created yet
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += read;
      this.pending += buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      const entry = parseSegmentLine(line);
      if (entry) this.onEntry(entry);
    }
  }
}
