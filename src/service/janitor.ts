import { EventEmitter } from 'node:events';
import { unlink as fsUnlink } from 'node:fs/promises';
import type { createClipRepo } from './clipRepo';
import type { ServiceConfig } from './config';
import { defaultFreeBytes } from './cutter';
import type { FeedClip } from './types';

const PAUSE_REASON = 'Мало места на диске: нарезка новых клипов приостановлена, запись эфиров продолжается';

export interface JanitorDeps {
  clips: ReturnType<typeof createClipRepo>;
  config: () => ServiceConfig;
  freeBytes?: () => Promise<number>;
  unlink?: (p: string) => Promise<void>;
  now?: () => Date;
}

/** Deletes MP4 files of rejected clips (TTL, or all of them when space is low) and pauses cutting if that is not enough. */
export class Janitor extends EventEmitter {
  private paused = false;
  private reason: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: JanitorDeps) {
    super();
  }

  state(): { paused: boolean; reason: string | null } {
    return { paused: this.paused, reason: this.reason };
  }

  start(intervalMs = 60000): void {
    if (this.timer) return;
    const tick = () => {
      this.run().catch((err) => console.error('janitor: run failed', err));
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = this.deps.config();
      const now = (this.deps.now ?? (() => new Date()))();
      const cutoff = new Date(now.getTime() - cfg.rejectedTtlHours * 3600_000).toISOString();
      for (const c of this.deps.clips.rejectedWithFiles(cutoff)) await this.deleteFile(c);

      let free = await this.free(cfg);
      if (free === null) return; // cannot measure: keep the current state
      if (free < cfg.diskReserveBytes) {
        for (const c of this.deps.clips.rejectedWithFiles()) await this.deleteFile(c);
        free = await this.free(cfg);
        if (free === null) return;
      }
      if (free < cfg.diskReserveBytes) this.setPaused(true, PAUSE_REASON);
      else this.setPaused(false, null);
    } finally {
      this.running = false;
    }
  }

  private async free(cfg: ServiceConfig): Promise<number | null> {
    try {
      return await (this.deps.freeBytes ?? (() => defaultFreeBytes(cfg.libraryDir)))();
    } catch (err) {
      console.error('janitor: cannot read free disk space', err);
      return null;
    }
  }

  private async deleteFile(c: FeedClip): Promise<void> {
    // The list was read before earlier (awaited) deletions: re-check in the same tick as the unlink call,
    // so a clip the user has just taken (or brought back to 'new') is never deleted.
    const current = this.deps.clips.get(c.id);
    if (!current || current.status !== 'rejected' || current.fileDeleted) return;
    try {
      await (this.deps.unlink ?? fsUnlink)(current.mp4Path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(`janitor: cannot delete ${current.mp4Path}`, err);
        return;
      }
    }
    this.deps.clips.update(c.id, { fileDeleted: true });
    const updated = this.deps.clips.get(c.id);
    if (updated) this.emit('clip', updated);
  }

  private setPaused(paused: boolean, reason: string | null): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.reason = reason;
    this.emit('cutting', { paused, reason });
  }
}
