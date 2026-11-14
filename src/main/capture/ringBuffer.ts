import { EventEmitter } from 'node:events';
import { unlink as fsUnlink } from 'node:fs/promises';
import type { Segment } from '@shared/types';
import type { Repos } from '../db/repos';

interface Pin {
  epoch: number;
  startMs: number;
  endMs: number;
}

export interface RingBufferOptions {
  segments: Repos['segments'];
  retentionMs: number;
  maxPinnedBytes: number;
  now?: () => number;
  unlink?: (path: string) => Promise<void>;
}

/** Strict overlap: a segment that merely touches the range boundary holds no content from it. */
const overlaps = (s: Segment, startMs: number, endMs: number) => s.endMs > startMs && s.startMs < endMs;

/**
 * Index of recorded segments. Segments older than the retention window are deleted unless a pin
 * (owned by a marker or a draft) overlaps them. Pinned data is never deleted automatically.
 * Events: 'segment' (Segment), 'pinLimit' ({ pinnedBytes, maxPinnedBytes }).
 */
export class RingBufferManager extends EventEmitter {
  private readonly byEpoch = new Map<number, Segment[]>();
  private readonly pins = new Map<string, Pin>();
  private readonly now: () => number;
  private readonly unlink: (path: string) => Promise<void>;
  private overLimit = false;
  private cleaning: Promise<void> | null = null;

  constructor(private readonly opts: RingBufferOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.unlink = opts.unlink ?? ((p) => fsUnlink(p));
  }

  add(seg: Segment): void {
    const list = this.byEpoch.get(seg.epoch) ?? [];
    list.push(seg);
    list.sort((a, b) => a.seq - b.seq);
    this.byEpoch.set(seg.epoch, list);
    this.opts.segments.insert(seg);
    this.emit('segment', seg);
    this.checkLimit();
  }

  pin(ownerId: string, epoch: number, startMs: number, endMs: number): void {
    this.pins.set(ownerId, { epoch, startMs, endMs });
    this.checkLimit();
  }

  unpin(ownerId: string): void {
    this.pins.delete(ownerId);
    this.checkLimit();
  }

  /** Deletes unpinned segments that left the retention window. Concurrent calls share one run. */
  cleanup(): Promise<void> {
    this.cleaning ??= this.runCleanup().finally(() => {
      this.cleaning = null;
    });
    return this.cleaning;
  }

  select(epoch: number, startMs: number, endMs: number): Segment[] {
    return (this.byEpoch.get(epoch) ?? []).filter((s) => overlaps(s, startMs, endMs));
  }

  latest(epoch: number): Segment | null {
    return this.byEpoch.get(epoch)?.at(-1) ?? null;
  }

  /** The newest epoch that still has segments, or null when the buffer is empty. */
  latestEpoch(): number | null {
    return this.byEpoch.size === 0 ? null : Math.max(...this.byEpoch.keys());
  }

  /** Duration available in the newest epoch within the retention window. */
  bufferedMs(): number {
    if (this.byEpoch.size === 0) return 0;
    const epoch = Math.max(...this.byEpoch.keys());
    const cutoff = this.now() - this.opts.retentionMs;
    let total = 0;
    for (const s of this.byEpoch.get(epoch) ?? []) if (s.completedAtWallMs >= cutoff) total += s.endMs - s.startMs;
    return total;
  }

  pinnedBytes(): number {
    let total = 0;
    for (const list of this.byEpoch.values()) for (const s of list) if (this.isPinned(s)) total += s.bytes;
    return total;
  }

  async clearAll(): Promise<void> {
    const all = [...this.byEpoch.values()].flat();
    this.byEpoch.clear();
    this.pins.clear();
    this.overLimit = false;
    this.opts.segments.clear();
    await Promise.all(all.map((s) => this.unlink(s.path).catch(() => undefined)));
  }

  private isPinned(s: Segment): boolean {
    for (const p of this.pins.values()) if (p.epoch === s.epoch && overlaps(s, p.startMs, p.endMs)) return true;
    return false;
  }

  private async runCleanup(): Promise<void> {
    const cutoff = this.now() - this.opts.retentionMs;
    for (const [epoch, list] of this.byEpoch) {
      const expired = list.filter((s) => s.completedAtWallMs < cutoff && !this.isPinned(s));
      for (const s of expired) {
        try {
          await this.unlink(s.path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue; // busy: retry on the next cleanup
        }
        const current = this.byEpoch.get(epoch);
        if (!current) break; // cleared meanwhile
        const i = current.indexOf(s);
        if (i >= 0) current.splice(i, 1);
        this.opts.segments.remove(s.sessionId, s.epoch, s.seq);
      }
      if (this.byEpoch.get(epoch)?.length === 0) this.byEpoch.delete(epoch);
    }
  }

  private checkLimit(): void {
    const pinnedBytes = this.pinnedBytes();
    const over = pinnedBytes > this.opts.maxPinnedBytes;
    if (over && !this.overLimit) this.emit('pinLimit', { pinnedBytes, maxPinnedBytes: this.opts.maxPinnedBytes });
    this.overLimit = over;
  }
}
