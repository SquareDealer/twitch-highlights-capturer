import type { Db } from '../main/db';
import type { ClipStatus, FeedClip } from './types';

type Row = Record<string, unknown>;

const toClip = (r: Row): FeedClip => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  streamer: r.streamer as string,
  streamId: r.stream_id as string,
  epoch: r.epoch as number,
  startMs: r.start_ms as number,
  endMs: r.end_ms as number,
  durationMs: r.duration_ms as number,
  bytes: r.bytes as number,
  triggers: JSON.parse(r.triggers as string) as FeedClip['triggers'],
  confidence: r.confidence as FeedClip['confidence'],
  score: r.score as number,
  signals: JSON.parse(r.signals as string) as FeedClip['signals'],
  status: r.status as ClipStatus,
  error: (r.error as string | null) ?? null,
  mp4Path: r.mp4_path as string,
  jsonPath: r.json_path as string,
  fileDeleted: (r.file_deleted as number) === 1,
  createdAt: r.created_at as string,
  statusChangedAt: (r.status_changed_at as string | null) ?? null,
});

const PATCH_COLUMNS: Record<string, string> = {
  status: 'status',
  error: 'error',
  durationMs: 'duration_ms',
  bytes: 'bytes',
  fileDeleted: 'file_deleted',
  statusChangedAt: 'status_changed_at',
};

export function createClipRepo(db: Db) {
  return {
    insert(c: FeedClip): void {
      db.prepare(
        `INSERT INTO feed_clips (id, session_id, streamer, stream_id, epoch, start_ms, end_ms, duration_ms, bytes, triggers,
           confidence, score, signals, status, error, mp4_path, json_path, file_deleted, created_at, status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.id, c.sessionId, c.streamer, c.streamId, c.epoch, c.startMs, c.endMs, c.durationMs, c.bytes,
        JSON.stringify(c.triggers), c.confidence, c.score, JSON.stringify(c.signals), c.status, c.error,
        c.mp4Path, c.jsonPath, c.fileDeleted ? 1 : 0, c.createdAt, c.statusChangedAt,
      );
    },
    get(id: string): FeedClip | null {
      const r = db.prepare('SELECT * FROM feed_clips WHERE id = ?').get(id) as Row | undefined;
      return r ? toClip(r) : null;
    },
    /** Newest first; limit defaults to 200. */
    list(filter: { streamer?: string; status?: ClipStatus; limit?: number } = {}): FeedClip[] {
      const where: string[] = [];
      const args: unknown[] = [];
      if (filter.streamer !== undefined) {
        where.push('streamer = ?');
        args.push(filter.streamer);
      }
      if (filter.status !== undefined) {
        where.push('status = ?');
        args.push(filter.status);
      }
      const sql = `SELECT * FROM feed_clips ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      return (db.prepare(sql).all(...args, filter.limit ?? 200) as Row[]).map(toClip);
    },
    update(
      id: string,
      patch: Partial<Pick<FeedClip, 'status' | 'error' | 'durationMs' | 'bytes' | 'fileDeleted' | 'statusChangedAt'>>,
    ): void {
      const keys = Object.keys(patch).filter((k) => k in PATCH_COLUMNS && (patch as Row)[k] !== undefined);
      if (keys.length === 0) return;
      const values = keys.map((k) => {
        const v = (patch as Row)[k];
        return typeof v === 'boolean' ? (v ? 1 : 0) : v;
      });
      db.prepare(`UPDATE feed_clips SET ${keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
    },
    /** Clips created since the given time, excluding 'error'. */
    countSince(sessionId: string, sinceIso: string): number {
      const r = db
        .prepare("SELECT COUNT(*) AS n FROM feed_clips WHERE session_id = ? AND created_at >= ? AND status != 'error'")
        .get(sessionId, sinceIso) as { n: number };
      return r.n;
    },
    scoresSince(sessionId: string, sinceIso: string): number[] {
      return (
        db
          .prepare("SELECT score FROM feed_clips WHERE session_id = ? AND created_at >= ? AND status != 'error' ORDER BY created_at")
          .all(sessionId, sinceIso) as { score: number }[]
      ).map((r) => r.score);
    },
    rejectedWithFiles(olderThanIso?: string): FeedClip[] {
      const sql = `SELECT * FROM feed_clips WHERE status = 'rejected' AND file_deleted = 0${
        olderThanIso ? ' AND COALESCE(status_changed_at, created_at) < ?' : ''
      } ORDER BY created_at`;
      const rows = (olderThanIso ? db.prepare(sql).all(olderThanIso) : db.prepare(sql).all()) as Row[];
      return rows.map(toClip);
    },
    failPending(error: string): number {
      return db
        .prepare("UPDATE feed_clips SET status = 'error', error = ?, status_changed_at = ? WHERE status = 'pending'")
        .run(error, new Date().toISOString()).changes;
    },
  };
}
