import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureSession, Draft, Result } from '@shared/types';
import { concatSegments, type ConcatFn } from '../capture/concat';
import type { RingBufferManager } from '../capture/ringBuffer';
import type { TimeSynchronizer } from '../capture/timeSync';
import type { Repos } from '../db/repos';
import type { SettingsStore } from '../settings';
import type { MomentService } from './momentService';

export { concatSegments, type ConcatFn };

export interface DraftServiceDeps {
  repos: Repos;
  ring: RingBufferManager;
  timeSync: TimeSynchronizer;
  moments: MomentService;
  currentSession: () => CaptureSession | null;
  settings: SettingsStore;
  draftsDir: string;
  concat?: ConcatFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
}

const POLL_MS = 250;
const TAIL_TIMEOUT_MS = 15_000;

/**
 * Drafts are MP4 files stitched from buffer segments; they survive restarts while raw segments do not.
 * A draft keeps its source range pinned so it can be extended while the data is still in the buffer.
 * Emits 'changed'.
 */
export class DraftService extends EventEmitter {
  private readonly concat: ConcatFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: DraftServiceDeps) {
    super();
    // Read the path on every call: the user may fix it in Settings while the app is running.
    this.concat = deps.concat ?? ((segments, outFile) => concatSegments(deps.settings.get().ffmpegPath)(segments, outFile));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /** F8: the last `replaySeconds` plus `replayTailSeconds` recorded after the key press. */
  captureReplay(): Promise<Result<Draft>> {
    return this.track(this.doCaptureReplay());
  }

  /** Resolves once every replay that is being assembled right now has finished. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const forget = () => void this.inFlight.delete(work);
    work.then(forget, forget);
    return work;
  }

  private async doCaptureReplay(): Promise<Result<Draft>> {
    const empty: Result<Draft> = { ok: false, error: 'Буфер пуст — нечего сохранять' };
    const session = this.deps.currentSession();
    if (!session) return empty;
    const { replaySeconds, replayTailSeconds } = this.deps.settings.get();
    const id = this.newId();
    const at = session.state === 'RECORDING' ? this.deps.timeSync.captureNow(this.now()) : null;

    let epoch: number;
    let startMs: number;
    let endMs: number;
    if (at) {
      epoch = at.epoch;
      startMs = at.sourceTimeMs - replaySeconds * 1000;
      endMs = at.sourceTimeMs + replayTailSeconds * 1000;
      this.deps.ring.pin(id, epoch, startMs, endMs);
      for (let waited = 0; waited < TAIL_TIMEOUT_MS; waited += POLL_MS) {
        if ((this.deps.ring.latest(epoch)?.endMs ?? -1) >= endMs) break;
        const now = this.deps.currentSession();
        // Stopping, reconnecting or gone: nothing more will arrive, take what exists.
        if (!now || now.id !== session.id || now.epoch !== epoch || now.state !== 'RECORDING') break;
        await this.sleep(POLL_MS);
      }
    } else {
      // Not recording right now (reconnecting, stream ended), but what was recorded before is still buffered.
      const latestEpoch = this.deps.ring.latestEpoch();
      const latest = latestEpoch === null ? null : this.deps.ring.latest(latestEpoch);
      if (latestEpoch === null || !latest) return empty;
      epoch = latestEpoch;
      endMs = latest.endMs;
      startMs = endMs - replaySeconds * 1000;
      this.deps.ring.pin(id, epoch, startMs, endMs);
    }
    const built = await this.build(id, session.id, epoch, startMs, endMs);
    if (!built.ok) return built.error === null ? empty : { ok: false, error: built.error };
    return { ok: true, value: built.value };
  }

  /**
   * Secures the footage of unsaved markers before the buffer is wiped: one draft per group of nearby
   * markers (per epoch) that no existing draft covers. Far-apart markers get separate drafts, because
   * the unpinned video between them is no longer in the buffer.
   */
  async createFromMarkers(sessionId: string): Promise<Draft[]> {
    const moment = this.deps.repos.moments.activeFor(sessionId);
    if (!moment || moment.markers.length === 0) return [];
    const existing = this.deps.repos.drafts.list().filter((d) => d.sessionId === sessionId);
    const uncovered = moment.markers.filter((m) => !existing.some((d) => d.epoch === m.epoch && m.sourceTimeMs >= d.startMs && m.sourceTimeMs <= d.endMs));
    const { pinBeforeMs, pinAfterMs } = this.deps.settings.get();
    const ranges: Array<{ epoch: number; startMs: number; endMs: number }> = [];
    for (const m of uncovered.sort((a, b) => a.epoch - b.epoch || a.sourceTimeMs - b.sourceTimeMs)) {
      const range = { epoch: m.epoch, startMs: m.sourceTimeMs - pinBeforeMs, endMs: m.sourceTimeMs + pinAfterMs };
      const last = ranges.at(-1);
      if (last && last.epoch === range.epoch && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
      else ranges.push(range);
    }
    const drafts: Draft[] = [];
    for (const range of ranges) {
      const id = this.newId();
      this.deps.ring.pin(id, range.epoch, range.startMs, range.endMs);
      const built = await this.build(id, sessionId, range.epoch, range.startMs, range.endMs);
      if (built.ok) drafts.push(built.value);
    }
    return drafts;
  }

  /** Widens the draft while the source segments are still buffered; returns the actual range. */
  async extend(draftId: string, by: { beforeMs: number; afterMs: number }): Promise<Draft> {
    const draft = this.deps.repos.drafts.get(draftId);
    if (!draft) throw new Error('Черновик не найден');
    const startMs = draft.startMs - Math.max(0, by.beforeMs);
    const endMs = draft.endMs + Math.max(0, by.afterMs);
    const segments = this.deps.ring.select(draft.epoch, startMs, endMs);
    const grows = segments.length > 0 && (segments[0]!.startMs < draft.startMs || segments.at(-1)!.endMs > draft.endMs);
    const covers = segments.length > 0 && segments[0]!.startMs <= draft.startMs && segments.at(-1)!.endMs >= draft.endMs;
    if (!grows || !covers) return draft;
    this.deps.ring.pin(draft.id, draft.epoch, startMs, endMs);
    const tmp = `${draft.filePath}.tmp.mp4`;
    try {
      await this.concat(segments.map((s) => s.path), tmp);
      await rename(tmp, draft.filePath);
    } catch (e) {
      await rm(tmp, { force: true });
      this.deps.ring.pin(draft.id, draft.epoch, draft.startMs, draft.endMs);
      throw new Error(`Не удалось расширить черновик: ${(e as Error).message}`);
    }
    this.deps.repos.drafts.update(draft.id, { startMs: segments[0]!.startMs, endMs: segments.at(-1)!.endMs });
    this.emit('changed');
    return this.deps.repos.drafts.get(draft.id)!;
  }

  async discard(draftId: string): Promise<void> {
    const draft = this.deps.repos.drafts.get(draftId);
    this.deps.ring.unpin(draftId);
    if (!draft) return;
    await rm(draft.filePath, { force: true }).catch(() => undefined);
    this.deps.repos.drafts.remove(draftId);
    this.deps.repos.moments.clearDraft(draftId);
    this.emit('changed');
  }

  list(): Draft[] {
    return this.deps.repos.drafts.list();
  }

  /** error === null means "no segments in range". */
  private async build(id: string, sessionId: string, epoch: number, startMs: number, endMs: number): Promise<{ ok: true; value: Draft } | { ok: false; error: string | null }> {
    const segments = this.deps.ring.select(epoch, startMs, endMs);
    if (segments.length === 0) {
      this.deps.ring.unpin(id);
      return { ok: false, error: null };
    }
    const filePath = join(this.deps.draftsDir, `${id}.mp4`);
    try {
      await mkdir(this.deps.draftsDir, { recursive: true });
      await this.concat(segments.map((s) => s.path), filePath);
    } catch (e) {
      this.deps.ring.unpin(id);
      await rm(filePath, { force: true }).catch(() => undefined);
      return { ok: false, error: `Не удалось собрать черновик: ${(e as Error).message}` };
    }
    const draft: Draft = {
      id, sessionId, epoch, filePath,
      startMs: segments[0]!.startMs,
      endMs: segments.at(-1)!.endMs,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.deps.repos.drafts.insert(draft);
    this.deps.repos.moments.setDraft(this.deps.moments.ensureActive(sessionId).id, id);
    this.emit('changed');
    return { ok: true, value: draft };
  }
}
