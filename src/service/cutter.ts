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

  constructor(private readonly deps: CutterDeps) {
    super();
    this.concat = deps.concat ?? ((segs, out) => concatSegments(deps.config().ffmpegPath)(segs, out));
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tailTimeoutMs = deps.tailTimeoutMs ?? 20_000;
  }

  /** Never throws: a failed cut turns the clip into 'error'. Resolves when the clip is finished. */
  async onEvent(ev: DetectorEvent): Promise<void> {
    try {
      const cfg = this.deps.config();
      if (await this.checkPaused(cfg)) return;
      if (this.overLimit(ev)) return;
      const preRoll = ev.confidence === 'low' && !ev.triggers.includes('audio') ? cfg.preRollLowConfidenceMs : cfg.preRollMs;
      const from = Math.max(0, ev.startMs - preRoll);
      const to = Math.min(ev.endMs + cfg.postRollMs, from + cfg.maxClipMs);
      await this.track(this.cut(ev, from, to, true));
    } catch (err) {
      console.error('cutter: onEvent failed', err);
    }
  }

  async manual(): Promise<Result<FeedClip>> {
    try {
      const cfg = this.deps.config();
      if (await this.checkPaused(cfg)) return { ok: false, error: 'Нарезка приостановлена' };
      const epoch = this.deps.session().epoch;
      const last = this.deps.ring.latest(epoch);
      if (!last) return { ok: false, error: 'Буфер пуст: нечего нарезать' };
      const to = last.endMs;
      const from = Math.max(0, to - cfg.manualClipMs);
      const ev: DetectorEvent = {
        epoch, startMs: from, endMs: to, triggerTimeMs: to, estimatedEventMs: to, uncertaintyMs: 0,
        triggers: ['manual'], confidence: 'normal', scores: { S: 0, C: 0, E: 0, U: 0, A: 0 },
        signals: { chatSpike: 0, laughShare: 0, reactionShare: 0, deltaDb: 0 },
      };
      const clip = await this.track(this.cut(ev, from, to, false));
      return clip.status === 'error' ? { ok: false, error: clip.error ?? 'Не удалось нарезать клип' } : { ok: true, value: clip };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Waits for all started clips without waiting for their tails: they are cut with what exists. */
  async flush(): Promise<void> {
    for (const wake of [...this.wakers]) wake();
    await Promise.allSettled([...this.active]);
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
        if (free < cfg.diskReserveBytes) reason = 'Мало свободного места на диске';
      } catch (err) {
        console.error('cutter: cannot read free disk space', err);
      }
    }
    if (reason === null) return false;
    this.emit('paused', { reason });
    return true;
  }

  /** Noise limiter: past the hourly quota only events scoring above the median of recent clips get through. */
  private overLimit(ev: DetectorEvent): boolean {
    const cfg = this.deps.config();
    const sessionId = this.deps.session().id;
    const since = new Date(this.now().getTime() - HOUR_MS).toISOString();
    if (this.deps.clips.countSince(sessionId, since) < cfg.maxClipsPerHour) return false;
    return ev.scores.S <= median(this.deps.clips.scoresSince(sessionId, since));
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
      score: ev.scores.S, signals: ev.signals, status: 'pending', error: null, mp4Path: paths.mp4Path,
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
      const durationMs = segs[segs.length - 1]!.endMs - segs[0]!.startMs;
      const done: FeedClip = { ...base, status: 'new', bytes, durationMs };
      const configVersion = createHash('sha1').update(JSON.stringify(cfg.detector)).digest('hex');
      try {
        await writeFile(paths.jsonPath, JSON.stringify({ ...done, event: ev, configVersion }, null, 2), 'utf8');
      } catch (err) {
        await rm(paths.mp4Path, { force: true });
        throw err;
      }
      clips.update(id, { status: 'new', bytes, durationMs });
    } catch (err) {
      await rm(part, { force: true }).catch(() => undefined);
      clips.update(id, {
        status: 'error', error: err instanceof Error ? err.message : String(err), statusChangedAt: this.now().toISOString(),
      });
    } finally {
      ring.unpin(id);
    }
    return this.emitClip(id);
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

  /** Resolves when the buffer reaches `to`, the epoch is over, the timeout expires or flush() is called. */
  private waitForTail(epoch: number, to: number): Promise<void> {
    const { ring } = this.deps;
    const ready = () => (ring.latest(epoch)?.endMs ?? -1) >= to || (ring.latestEpoch() ?? epoch) > epoch;
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

async function defaultFreeBytes(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}
