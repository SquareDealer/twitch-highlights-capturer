import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import type { CaptureSession, Result, Segment } from '@shared/types';
import { concatSegments, type ConcatFn } from '../main/capture/concat';
import type { RingBufferManager } from '../main/capture/ringBuffer';
import { feedClipPaths } from './clipPaths';
import type { createClipRepo } from './clipRepo';
import type { ServiceConfig } from './config';
import type { DetectorEvent, FeedClip } from './types';

export interface CutterDeps {
  ring: RingBufferManager;
  clips: ReturnType<typeof createClipRepo>;
  config: () => ServiceConfig;
  session: () => CaptureSession;
  concat?: ConcatFn;
  freeBytes?: () => Promise<number>;
  /** Cutting pause requested by the Janitor. */
  paused?: () => boolean;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  tailTimeoutMs?: number;
}

const CONCAT_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1000;
const HOUR_MS = 3_600_000;
const DISK_REASON = 'Мало свободного места на диске';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Turns detector events into MP4 clips: pins the range in the ring buffer, waits for the tail,
 * concatenates segments without re-encoding and tracks the clip in the feed table.
 * Events: 'clip' (FeedClip, on every change of a record), 'paused' ({ reason }).
 */
export class Cutter extends EventEmitter {
  private readonly active = new Set<Promise<unknown>>();
  private readonly wakers = new Set<() => void>();
  private readonly concat: ConcatFn;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tailTimeoutMs: number;
  /** Set by flush(): the stream is over, no tail will come any more. */
  private closed = false;
  /** Reason of the last 'paused' notice; null while cutting runs. */
  private pausedReason: string | null = null;

  constructor(private readonly deps: CutterDeps) {
    super();
    this.concat = deps.concat ?? ((segs, out) => concatSegments(deps.config().ffmpegPath)(segs, out));
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tailTimeoutMs = deps.tailTimeoutMs ?? 20_000;
  }

  /**
   * Never throws: a failed cut turns the clip into 'error'. Resolves when the clip is finished.
   * The work is registered synchronously, so a flush() called right after sees it.
   */
  onEvent(ev: DetectorEvent): Promise<void> {
    return this.track(this.handleEvent(ev));
  }

  private async handleEvent(ev: DetectorEvent): Promise<void> {
    try {
      const cfg = this.deps.config();
      if (await this.checkPaused(cfg)) return;
      if (this.overLimit(ev)) return;
      const preRoll = ev.confidence === 'low' && !ev.triggers.includes('audio') ? cfg.preRollLowConfidenceMs : cfg.preRollMs;
      const from = Math.max(0, ev.startMs - preRoll);
      const to = Math.min(ev.endMs + cfg.postRollMs, from + cfg.maxClipMs);
      await this.cut(ev, from, to, true);
    } catch (err) {
      console.error('cutter: onEvent failed', err);
    }
  }

  manual(): Promise<Result<FeedClip>> {
    return this.track(this.handleManual());
  }

  private async handleManual(): Promise<Result<FeedClip>> {
    try {
      const cfg = this.deps.config();
      if (await this.checkPaused(cfg)) return { ok: false, error: 'Нарезка приостановлена' };
      const { ring } = this.deps;
      let epoch = this.deps.session().epoch;
      let last = ring.latest(epoch);
      // Right after a reconnect the new epoch has no segments yet: save the end of the previous one.
      const newest = last ? null : ring.latestEpoch();
      if (newest !== null) {
        epoch = newest;
        last = ring.latest(newest);
      }
      if (!last) return { ok: false, error: 'Буфер пуст: нечего нарезать' };
      const to = last.endMs;
      const from = Math.max(0, to - cfg.manualClipMs);
      const ev: DetectorEvent = {
        epoch, startMs: from, endMs: to, triggerTimeMs: to, estimatedEventMs: to, uncertaintyMs: 0,
        triggers: ['manual'], confidence: 'normal', scores: { total: 0, share: 0, speed: 0, audio: 0 },
        signals: { chatSpike: 0, laughShare: 0, reactionShare: 0, deltaDb: 0 },
      };
      const clip = await this.cut(ev, from, to, false);
      return clip.status === 'error' ? { ok: false, error: clip.error ?? 'Не удалось нарезать клип' } : { ok: true, value: clip };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The stream is over: waits for all started clips without waiting for their tails (they are cut with
   * what exists). Events arriving later are cut at once from what exists too.
   */
  async flush(): Promise<void> {
    this.closed = true;
    for (const wake of [...this.wakers]) wake();
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.active.add(p);
    const done = () => void this.active.delete(p);
    p.then(done, done);
    return p;
  }

  private async checkPaused(cfg: ServiceConfig): Promise<boolean> {
    let reason: string | null = null;
    if (this.deps.paused?.()) {
      reason = 'Нарезка приостановлена';
    } else {
      try {
        const free = await (this.deps.freeBytes ?? (() => defaultFreeBytes(cfg.libraryDir)))();
        if (free < cfg.diskReserveBytes) reason = DISK_REASON;
      } catch (err) {
        console.error('cutter: cannot read free disk space', err);
      }
    }
    if (reason === null) {
      this.pausedReason = null;
      return false;
    }
    this.notePaused(reason);
    return true;
  }

  /** Emits 'paused' only when the pause starts or its reason changes, not for every dropped event. */
  private notePaused(reason: string): void {
    if (reason === this.pausedReason) return;
    this.pausedReason = reason;
    this.emit('paused', { reason });
  }

  /** Noise limiter: past the hourly quota only events scoring above the median of recent clips get through. */
  private overLimit(ev: DetectorEvent): boolean {
    const cfg = this.deps.config();
    const sessionId = this.deps.session().id;
    const since = new Date(this.now().getTime() - HOUR_MS).toISOString();
    if (this.deps.clips.countSince(sessionId, since) < cfg.maxClipsPerHour) return false;
    return ev.scores.total <= median(this.deps.clips.scoresSince(sessionId, since));
  }

  private emitClip(id: string): FeedClip {
    const clip = this.deps.clips.get(id)!;
    this.emit('clip', clip);
    return clip;
  }

  private async cut(ev: DetectorEvent, from: number, to: number, waitTail: boolean): Promise<FeedClip> {
    const { ring, clips } = this.deps;
    const cfg = this.deps.config();
    const session = this.deps.session();
    const createdAt = this.now();
    const id = this.newId();
    const paths = feedClipPaths(cfg.libraryDir, session, createdAt, ev.triggers, id);
    const base: FeedClip = {
      id, sessionId: session.id, streamer: session.streamer, streamId: session.streamId, epoch: ev.epoch,
      startMs: from, endMs: to, durationMs: to - from, bytes: 0, triggers: ev.triggers, confidence: ev.confidence,
      score: ev.scores.total, signals: ev.signals, status: 'pending', error: null, mp4Path: paths.mp4Path,
      jsonPath: paths.jsonPath, fileDeleted: false, createdAt: createdAt.toISOString(), statusChangedAt: null,
    };
    clips.insert(base);
    this.emitClip(id);
    ring.pin(id, ev.epoch, from, to);
    const part = `${paths.mp4Path}.part`;
    try {
      if (waitTail) await this.waitForTail(ev.epoch, to);
      const segs: Segment[] = ring.select(ev.epoch, from, to);
      if (segs.length === 0) throw new Error('В буфере не осталось сегментов для этого фрагмента');
      await mkdir(paths.dir, { recursive: true });
      await this.concatWithRetry(segs.map((s) => s.path), part);
      await rename(part, paths.mp4Path);
      const bytes = (await stat(paths.mp4Path)).size;
      // The MP4 holds whole segments: describe the footage actually cut, not the requested range.
      const startMs = segs[0]!.startMs;
      const endMs = segs[segs.length - 1]!.endMs;
      const durationMs = endMs - startMs;
      const done: FeedClip = { ...base, status: 'new', bytes, startMs, endMs, durationMs };
      const configVersion = createHash('sha1').update(JSON.stringify(cfg.detector)).digest('hex');
      try {
        await writeFile(paths.jsonPath, JSON.stringify({ ...done, event: ev, configVersion }, null, 2), 'utf8');
      } catch (err) {
        await rm(paths.mp4Path, { force: true });
        throw err;
      }
      clips.update(id, { status: 'new', bytes, startMs, endMs, durationMs });
    } catch (err) {
      await rm(part, { force: true }).catch(() => undefined);
      clips.update(id, {
        status: 'error', error: err instanceof Error ? err.message : String(err), statusChangedAt: this.now().toISOString(),
      });
      if (await this.diskIsFull(err, cfg)) this.notePaused(DISK_REASON);
    } finally {
      ring.unpin(id);
    }
    return this.emitClip(id);
  }

  /** After a failed cut: was the disk the cause (ENOSPC), or is free space now below the reserve? */
  private async diskIsFull(err: unknown, cfg: ServiceConfig): Promise<boolean> {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'ENOSPC' || /no space left/i.test(e?.message ?? '')) return true;
    try {
      return (await (this.deps.freeBytes ?? (() => defaultFreeBytes(cfg.libraryDir)))()) < cfg.diskReserveBytes;
    } catch {
      return false;
    }
  }

  private async concatWithRetry(paths: string[], out: string): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= CONCAT_ATTEMPTS; attempt++) {
      try {
        await this.concat(paths, out);
        return;
      } catch (err) {
        last = err;
        await rm(out, { force: true }).catch(() => undefined);
        if (attempt < CONCAT_ATTEMPTS) await this.sleep(RETRY_PAUSE_MS);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** Resolves when the buffer reaches `to`, the epoch is over, the timeout expires or flush() was called. */
  private waitForTail(epoch: number, to: number): Promise<void> {
    const { ring } = this.deps;
    const ready = () => this.closed || (ring.latest(epoch)?.endMs ?? -1) >= to || (ring.latestEpoch() ?? epoch) > epoch;
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        ring.off('segment', onSegment);
        this.wakers.delete(finish);
        resolve();
      };
      const onSegment = () => {
        if (ready()) finish();
      };
      const timer = setTimeout(finish, this.tailTimeoutMs);
      ring.on('segment', onSegment);
      this.wakers.add(finish);
    });
  }
}

export async function defaultFreeBytes(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}
