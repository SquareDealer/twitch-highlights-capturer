import type { CaptureSession, Clip, Draft, Marker, Moment, MomentStatus, Segment, SyncStatus } from '@shared/types';
import type { Db } from './index';

export interface DriveFileRow {
  clipId: string;
  kind: 'mp4' | 'markers';
  driveFileId: string;
  version: string;
  md5: string;
  status: 'synced' | 'failed';
}

export interface Repos {
  db: Db;
  sessions: {
    insert(s: CaptureSession): void;
    update(id: string, patch: Partial<CaptureSession> & { endedAt?: string }): void;
    get(id: string): CaptureSession | null;
  };
  segments: { insert(s: Segment): void; remove(sessionId: string, epoch: number, seq: number): void; clear(): void };
  moments: {
    insert(m: Omit<Moment, 'markers'>): void;
    get(id: string): Moment | null;
    activeFor(sessionId: string): Moment | null;
    forDraft(draftId: string): Moment | null;
    setStatus(id: string, s: MomentStatus): void;
    setDraft(id: string, draftId: string | null): void;
    listByStatus(s: MomentStatus): Moment[];
  };
  markers: {
    insert(m: Marker): void;
    update(id: string, patch: Partial<Pick<Marker, 'type' | 'sourceTimeMs' | 'comment' | 'momentId'>>): void;
    remove(id: string): void;
    get(id: string): Marker | null;
  };
  drafts: {
    insert(d: Draft): void;
    update(id: string, patch: Partial<Pick<Draft, 'startMs' | 'endMs'>>): void;
    get(id: string): Draft | null;
    list(): Draft[];
    remove(id: string): void;
  };
  clips: { insert(c: Clip): void; get(id: string): Clip | null; list(): Clip[]; setSyncStatus(id: string, s: SyncStatus): void };
  driveFiles: {
    get(clipId: string, kind: 'mp4' | 'markers'): DriveFileRow | null;
    upsert(r: DriveFileRow): void;
    getFolder(pathKey: string): string | null;
    setFolder(pathKey: string, driveId: string): void;
  };
}

type Row = Record<string, unknown>;

/** Builds `UPDATE table SET col = ? ... WHERE id = ?` from a camelCase patch using an explicit column map. */
function updateById(db: Db, table: string, id: string, patch: Row, columns: Record<string, string>): void {
  const keys = Object.keys(patch).filter((k) => k in columns && patch[k] !== undefined);
  if (keys.length === 0) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => patch[k]), id);
}

const toSession = (r: Row): CaptureSession => ({
  id: r.id as string,
  streamer: r.streamer as string,
  streamId: r.stream_id as string,
  state: r.state as CaptureSession['state'],
  startedAt: r.started_at as string,
  epoch: r.epoch as number,
  ...(r.error ? { error: r.error as string } : {}),
});
const toMarker = (r: Row): Marker => ({
  id: r.id as string,
  momentId: r.moment_id as string,
  epoch: r.epoch as number,
  type: r.type as Marker['type'],
  sourceTimeMs: r.source_time_ms as number,
  comment: r.comment as string,
});
const toDraft = (r: Row): Draft => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  epoch: r.epoch as number,
  startMs: r.start_ms as number,
  endMs: r.end_ms as number,
  filePath: r.file_path as string,
  createdAt: r.created_at as string,
});
const toClip = (r: Row): Clip => ({
  id: r.id as string,
  momentId: r.moment_id as string,
  sessionId: r.session_id as string,
  title: r.title as string,
  dir: r.dir as string,
  mp4Path: r.mp4_path as string,
  markersPath: r.markers_path as string,
  durationMs: r.duration_ms as number,
  createdAt: r.created_at as string,
  syncStatus: r.sync_status as SyncStatus,
});

export function createRepos(db: Db): Repos {
  const markersOf = db.prepare('SELECT * FROM markers WHERE moment_id = ? ORDER BY epoch, source_time_ms, id');
  const toMoment = (r: Row | undefined): Moment | null =>
    r
      ? {
          id: r.id as string,
          streamSessionId: r.session_id as string,
          status: r.status as MomentStatus,
          draftId: (r.draft_id as string | null) ?? null,
          markers: (markersOf.all(r.id) as Row[]).map(toMarker),
        }
      : null;

  const moments: Repos['moments'] = {
    insert: (m) => {
      db.prepare('INSERT INTO moments (id, session_id, status, draft_id) VALUES (?, ?, ?, ?)').run(m.id, m.streamSessionId, m.status, m.draftId);
    },
    get: (id) => toMoment(db.prepare('SELECT * FROM moments WHERE id = ?').get(id) as Row | undefined),
    activeFor: (sessionId) =>
      toMoment(db.prepare("SELECT * FROM moments WHERE session_id = ? AND status = 'ACTIVE' ORDER BY rowid DESC LIMIT 1").get(sessionId) as Row | undefined),
    forDraft: (draftId) => {
      const own = db
        .prepare("SELECT * FROM moments WHERE draft_id = ? AND status IN ('FAILED', 'EXPORTING') ORDER BY rowid DESC LIMIT 1")
        .get(draftId) as Row | undefined;
      if (own) return toMoment(own);
      const draft = db.prepare('SELECT session_id FROM drafts WHERE id = ?').get(draftId) as Row | undefined;
      return draft ? moments.activeFor(draft.session_id as string) : null;
    },
    setStatus: (id, s) => {
      db.prepare('UPDATE moments SET status = ? WHERE id = ?').run(s, id);
    },
    setDraft: (id, draftId) => {
      db.prepare('UPDATE moments SET draft_id = ? WHERE id = ?').run(draftId, id);
    },
    listByStatus: (s) => (db.prepare('SELECT * FROM moments WHERE status = ? ORDER BY rowid').all(s) as Row[]).map((r) => toMoment(r)!),
  };

  return {
    db,
    sessions: {
      insert: (s) => {
        db.prepare('INSERT INTO capture_sessions (id, streamer, stream_id, state, started_at, epoch, error) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          s.id, s.streamer, s.streamId, s.state, s.startedAt, s.epoch, s.error ?? null,
        );
      },
      update: (id, patch) =>
        updateById(db, 'capture_sessions', id, patch as Row, {
          streamer: 'streamer', streamId: 'stream_id', state: 'state', startedAt: 'started_at', epoch: 'epoch', error: 'error', endedAt: 'ended_at',
        }),
      get: (id) => {
        const r = db.prepare('SELECT * FROM capture_sessions WHERE id = ?').get(id) as Row | undefined;
        return r ? toSession(r) : null;
      },
    },
    segments: {
      insert: (s) => {
        db.prepare('INSERT OR REPLACE INTO buffer_segments (session_id, epoch, seq, path, start_ms, end_ms, bytes, completed_at_wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          s.sessionId, s.epoch, s.seq, s.path, s.startMs, s.endMs, s.bytes, s.completedAtWallMs,
        );
      },
      remove: (sessionId, epoch, seq) => {
        db.prepare('DELETE FROM buffer_segments WHERE session_id = ? AND epoch = ? AND seq = ?').run(sessionId, epoch, seq);
      },
      clear: () => {
        db.prepare('DELETE FROM buffer_segments').run();
      },
    },
    moments,
    markers: {
      insert: (m) => {
        db.prepare('INSERT INTO markers (id, moment_id, epoch, type, source_time_ms, comment) VALUES (?, ?, ?, ?, ?, ?)').run(
          m.id, m.momentId, m.epoch, m.type, m.sourceTimeMs, m.comment,
        );
      },
      update: (id, patch) =>
        updateById(db, 'markers', id, patch as Row, { type: 'type', sourceTimeMs: 'source_time_ms', comment: 'comment', momentId: 'moment_id' }),
      remove: (id) => {
        db.prepare('DELETE FROM markers WHERE id = ?').run(id);
      },
      get: (id) => {
        const r = db.prepare('SELECT * FROM markers WHERE id = ?').get(id) as Row | undefined;
        return r ? toMarker(r) : null;
      },
    },
    drafts: {
      insert: (d) => {
        db.prepare('INSERT INTO drafts (id, session_id, epoch, start_ms, end_ms, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          d.id, d.sessionId, d.epoch, d.startMs, d.endMs, d.filePath, d.createdAt,
        );
      },
      update: (id, patch) => updateById(db, 'drafts', id, patch as Row, { startMs: 'start_ms', endMs: 'end_ms' }),
      get: (id) => {
        const r = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
        return r ? toDraft(r) : null;
      },
      list: () => (db.prepare('SELECT * FROM drafts ORDER BY created_at, rowid').all() as Row[]).map(toDraft),
      remove: (id) => {
        db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
      },
    },
    clips: {
      insert: (c) => {
        db.prepare('INSERT INTO clips (id, moment_id, session_id, title, dir, mp4_path, markers_path, duration_ms, created_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          c.id, c.momentId, c.sessionId, c.title, c.dir, c.mp4Path, c.markersPath, c.durationMs, c.createdAt, c.syncStatus,
        );
      },
      get: (id) => {
        const r = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as Row | undefined;
        return r ? toClip(r) : null;
      },
      list: () => (db.prepare('SELECT * FROM clips ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(toClip),
      setSyncStatus: (id, s) => {
        db.prepare('UPDATE clips SET sync_status = ? WHERE id = ?').run(s, id);
      },
    },
    driveFiles: {
      get: (clipId, kind) => {
        const r = db.prepare('SELECT * FROM drive_files WHERE clip_id = ? AND kind = ?').get(clipId, kind) as Row | undefined;
        return r
          ? { clipId, kind, driveFileId: r.drive_file_id as string, version: r.version as string, md5: r.md5 as string, status: r.status as DriveFileRow['status'] }
          : null;
      },
      upsert: (r) => {
        db.prepare('INSERT OR REPLACE INTO drive_files (clip_id, kind, drive_file_id, version, md5, status) VALUES (?, ?, ?, ?, ?, ?)').run(
          r.clipId, r.kind, r.driveFileId, r.version, r.md5, r.status,
        );
      },
      getFolder: (pathKey) => {
        const r = db.prepare('SELECT drive_id FROM drive_folders WHERE path_key = ?').get(pathKey) as Row | undefined;
        return r ? (r.drive_id as string) : null;
      },
      setFolder: (pathKey, driveId) => {
        db.prepare('INSERT OR REPLACE INTO drive_folders (path_key, drive_id) VALUES (?, ?)').run(pathKey, driveId);
      },
    },
  };
}
