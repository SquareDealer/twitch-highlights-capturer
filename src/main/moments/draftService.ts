import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureSession, Draft, Result } from '@shared/types';
import type { RingBufferManager } from '../capture/ringBuffer';
import type { TimeSynchronizer } from '../capture/timeSync';
import type { Repos } from '../db/repos';
import type { SettingsStore } from '../settings';
import type { MomentService } from './momentService';

export type ConcatFn = (segments: string[], outFile: string) => Promise<void>;

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

/** Joins MPEG-TS segments into one MP4 without re-encoding. */
export function concatSegments(ffmpegPath: string): ConcatFn {
  return async (segments, outFile) => {
    const listFile = `${outFile}.txt`;
    // concat demuxer syntax: single-quoted path, a literal quote is written as '\''
    const list = segments.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listFile, `${list}\n`, 'utf8');
    try {
      await new Promise<void>((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', outFile];
        execFile(ffmpegPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
          err ? reject(new Error(String(stderr).trim().split('\n').pop() || err.message)) : resolve(),
        );
      });
    } finally {
      await rm(listFile, { force: true });
    }
  };
}

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

  constructor(private readonly deps: DraftServiceDeps) {
    super();
    this.concat = deps.concat ?? concatSegments(deps.settings.get().ffmpegPath);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /** F8: the last `replaySeconds` plus `replayTailSeconds` recorded after the key press. */
  async captureReplay(): Promise<Result<Draft>> {
    const session = this.deps.currentSession();
    const at = session?.state === 'RECORDING' ? this.deps.timeSync.captureNow(this.now()) : null;
    if (!session || !at) return { ok: false, error: 'Буфер пуст — нечего сохранять' };
    const { replaySeconds, replayTailSeconds } = this.deps.settings.get();
    const id = this.newId();
    const startMs = at.sourceTimeMs - replaySeconds * 1000;
    const endMs = at.sourceTimeMs + replayTailSeconds * 1000;
    this.deps.ring.pin(id, at.epoch, startMs, endMs);
    for (let waited = 0; waited < TAIL_TIMEOUT_MS; waited += POLL_MS) {
      if ((this.deps.ring.latest(at.epoch)?.endMs ?? -1) >= endMs) break;
      const now = this.deps.currentSession();
      if (!now || now.id !== session.id || now.epoch !== at.epoch) break; // stopped or reconnected: take what exists
      await this.sleep(POLL_MS);
    }
    const built = await this.build(id, session.id, at.epoch, startMs, endMs);
    if (!built.ok) return built.error === null ? { ok: false, error: 'Буфер пуст — нечего сохранять' } : { ok: false, error: built.error };
    return { ok: true, value: built.value };
  }

  /** Auto-draft for unsaved markers (called before the buffer is wiped). */
  async createFromMarkers(sessionId: string): Promise<Draft | null> {
    const moment = this.deps.repos.moments.activeFor(sessionId);
    if (!moment || moment.draftId || moment.markers.length === 0) return null;
    const epoch = moment.markers.at(-1)!.epoch;
    const times = moment.markers.filter((m) => m.epoch === epoch).map((m) => m.sourceTimeMs);
    const { pinBeforeMs, pinAfterMs } = this.deps.settings.get();
    const id = this.newId();
    const startMs = Math.min(...times) - pinBeforeMs;
    const endMs = Math.max(...times) + pinAfterMs;
    this.deps.ring.pin(id, epoch, startMs, endMs);
    const built = await this.build(id, sessionId, epoch, startMs, endMs);
    return built.ok ? built.value : null;
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
