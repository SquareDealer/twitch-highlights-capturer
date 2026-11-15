import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE capture_sessions (
    id TEXT PRIMARY KEY, streamer TEXT NOT NULL, stream_id TEXT NOT NULL, state TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, epoch INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE buffer_segments (
    session_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, path TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, completed_at_wall_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, epoch, seq)
  );
  CREATE TABLE moments (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, draft_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX moments_session ON moments (session_id, status);
  CREATE TABLE markers (
    id TEXT PRIMARY KEY, moment_id TEXT NOT NULL, epoch INTEGER NOT NULL, type INTEGER NOT NULL,
    source_time_ms INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX markers_moment ON markers (moment_id);
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch INTEGER NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, file_path TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE clips (
    id TEXT PRIMARY KEY, moment_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL, dir TEXT NOT NULL,
    mp4_path TEXT NOT NULL, markers_path TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL,
    sync_status TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    dedupe_key TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_ready ON jobs (type, status, next_run_at);
  CREATE TABLE drive_files (
    clip_id TEXT NOT NULL, kind TEXT NOT NULL, drive_file_id TEXT NOT NULL, version TEXT NOT NULL,
    md5 TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (clip_id, kind)
  );
  CREATE TABLE drive_folders (path_key TEXT PRIMARY KEY, drive_id TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE feed_clips (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, streamer TEXT NOT NULL, stream_id TEXT NOT NULL,
    epoch INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    bytes INTEGER NOT NULL, triggers TEXT NOT NULL, confidence TEXT NOT NULL, score REAL NOT NULL,
    signals TEXT NOT NULL, status TEXT NOT NULL, error TEXT, mp4_path TEXT NOT NULL, json_path TEXT NOT NULL,
    file_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, status_changed_at TEXT
  );
  CREATE INDEX feed_clips_streamer ON feed_clips (streamer, created_at);
  CREATE INDEX feed_clips_status ON feed_clips (status);
  `,
];

/** Opens (and migrates) the application database. Use ':memory:' in tests. */
export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
