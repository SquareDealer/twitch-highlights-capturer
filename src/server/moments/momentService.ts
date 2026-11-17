import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { CaptureSession, Draft, Marker, MarkerType, Moment, Result } from '@shared/types';
import type { RingBufferManager } from '../capture/ringBuffer';
import type { TimeSynchronizer } from '../capture/timeSync';
import type { Repos } from '../db/repos';
import type { SettingsStore } from '../settings';

export interface MomentServiceDeps {
  repos: Repos;
  ring: RingBufferManager;
  timeSync: TimeSynchronizer;
  currentSession: () => CaptureSession | null;
  settings: SettingsStore;
  newId?: () => string;
}

const MAX_COMMENT_LENGTH = 500;
const cleanComment = (s: string) => String(s).trim().slice(0, MAX_COMMENT_LENGTH);

/**
 * Markers and the moment lifecycle: ACTIVE → EXPORTING → SAVED | FAILED, or DISCARDED.
 * Every session always has exactly one ACTIVE moment that collects new markers.
 * Emits 'changed' (sessionId).
 */
export class MomentService extends EventEmitter {
  private readonly newId: () => string;

  constructor(private readonly deps: MomentServiceDeps) {
    super();
    this.newId = deps.newId ?? randomUUID;
  }

  ensureActive(sessionId: string): Moment {
    const existing = this.deps.repos.moments.activeFor(sessionId);
    if (existing) return existing;
    const id = this.newId();
    this.deps.repos.moments.insert({ id, streamSessionId: sessionId, status: 'ACTIVE', draftId: null });
    return this.deps.repos.moments.get(id)!;
  }

  /** The marker time is fixed here, from the wall-clock time of the key press. */
  addMarker(type: MarkerType, wallMs: number): Result<Marker> {
    const session = this.deps.currentSession();
    const time = session?.state === 'RECORDING' ? this.deps.timeSync.markerTime(wallMs) : null;
    if (!session || !time) return { ok: false, error: 'Запись не идёт — маркер не поставлен' };
    const moment = this.ensureActive(session.id);
    const marker: Marker = { id: this.newId(), momentId: moment.id, epoch: time.epoch, type, sourceTimeMs: time.sourceTimeMs, comment: '' };
    this.deps.repos.markers.insert(marker);
    this.pinMarker(marker);
    this.emit('changed', session.id);
    return { ok: true, value: marker };
  }

  setComment(markerId: string, comment: string): void {
    this.updateMarker(markerId, { comment });
  }

  updateMarker(markerId: string, patch: { sourceTimeMs?: number; comment?: string; type?: MarkerType }): void {
    const marker = this.deps.repos.markers.get(markerId);
    if (!marker) return;
    const clean: { sourceTimeMs?: number; comment?: string; type?: MarkerType } = {};
    if (typeof patch.sourceTimeMs === 'number' && Number.isFinite(patch.sourceTimeMs)) clean.sourceTimeMs = Math.max(0, Math.round(patch.sourceTimeMs));
    if (typeof patch.comment === 'string') clean.comment = cleanComment(patch.comment);
    if (Number.isInteger(patch.type) && patch.type! >= 1 && patch.type! <= 9) clean.type = patch.type;
    this.deps.repos.markers.update(markerId, clean);
    if (clean.sourceTimeMs !== undefined) this.pinMarker({ ...marker, sourceTimeMs: clean.sourceTimeMs });
    this.emitForMoment(marker.momentId);
  }

  removeMarker(markerId: string): void {
    const marker = this.deps.repos.markers.get(markerId);
    if (!marker) return;
    this.deps.repos.markers.remove(markerId);
    this.deps.ring.unpin(markerId);
    this.emitForMoment(marker.momentId);
  }

  /**
   * Freezes the marker set that goes with `draft` and opens a fresh ACTIVE moment for whatever comes next.
   * Markers outside the draft (other epoch or outside its range) move to the new moment, pins untouched.
   * Retrying a FAILED moment only flips its status.
   */
  beginExport(draft: Draft): Moment {
    const { moments, markers, db } = this.deps.repos;
    const moment = moments.forDraft(draft.id) ?? this.ensureActive(draft.sessionId);
    if (moment.status === 'FAILED' || moment.status === 'EXPORTING') {
      moments.setStatus(moment.id, 'EXPORTING');
    } else {
      db.transaction(() => {
        const nextId = this.newId();
        moments.setStatus(moment.id, 'EXPORTING');
        moments.setDraft(moment.id, draft.id);
        moments.insert({ id: nextId, streamSessionId: moment.streamSessionId, status: 'ACTIVE', draftId: null });
        for (const m of moment.markers) {
          const inside = m.epoch === draft.epoch && m.sourceTimeMs >= draft.startMs && m.sourceTimeMs <= draft.endMs;
          if (!inside) markers.update(m.id, { momentId: nextId });
        }
      })();
    }
    this.emit('changed', moment.streamSessionId);
    return moments.get(moment.id)!;
  }

  completeExport(momentId: string): void {
    const moment = this.deps.repos.moments.get(momentId);
    if (!moment) return;
    this.deps.repos.moments.setStatus(momentId, 'SAVED');
    for (const m of moment.markers) this.deps.ring.unpin(m.id);
    this.emit('changed', moment.streamSessionId);
  }

  failExport(momentId: string): void {
    const moment = this.deps.repos.moments.get(momentId);
    if (!moment) return;
    this.deps.repos.moments.setStatus(momentId, 'FAILED');
    this.emit('changed', moment.streamSessionId);
  }

  discardActive(sessionId: string): void {
    const moment = this.deps.repos.moments.activeFor(sessionId);
    if (moment) {
      this.deps.repos.db.transaction(() => {
        for (const m of moment.markers) this.deps.repos.markers.remove(m.id);
        this.deps.repos.moments.setStatus(moment.id, 'DISCARDED');
      })();
      for (const m of moment.markers) this.deps.ring.unpin(m.id);
    }
    this.ensureActive(sessionId);
    this.emit('changed', sessionId);
  }

  private pinMarker(marker: Marker): void {
    const { pinBeforeMs, pinAfterMs } = this.deps.settings.get();
    this.deps.ring.pin(marker.id, marker.epoch, marker.sourceTimeMs - pinBeforeMs, marker.sourceTimeMs + pinAfterMs);
  }

  private emitForMoment(momentId: string): void {
    const moment = this.deps.repos.moments.get(momentId);
    if (moment) this.emit('changed', moment.streamSessionId);
  }
}
