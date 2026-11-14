import type { DriveStatus, Notice, Result } from '@shared/types';
import type { Repos } from '../db/repos';
import { JobQueue } from '../jobs/jobQueue';
import type { SettingsStore } from '../settings';
import type { DriveClient } from './driveClient';
import { SyncWorker, type SyncJob } from './syncWorker';

export interface DriveSyncDeps {
  repos: Repos;
  settings: SettingsStore;
  auth: {
    status(): Promise<DriveStatus>;
    isConnected(): Promise<boolean>;
    connect(): Promise<Result<null>>;
    disconnect(): Promise<void>;
  };
  getClient: () => Promise<DriveClient | null>;
  notify: (n: Notice) => void;
  clipsChanged: () => void;
  backoffMs?: (attempt: number) => number;
}

const MAX_ATTEMPTS = 5;
const NOT_CONNECTED: Notice = { level: 'warn', message: 'Google Drive не подключён — откройте «Настройки»' };

/**
 * Background synchronisation of saved clips with Google Drive.
 * Independent of capture: jobs live in SQLite, survive restarts and are retried with exponential backoff.
 */
export function createDriveSync(deps: DriveSyncDeps) {
  const { repos } = deps;
  const worker = new SyncWorker({ repos, getClient: deps.getClient });
  const queue = new JobQueue<SyncJob>(
    repos.db,
    'sync',
    async (job) => {
      await worker.handle(job);
      deps.clipsChanged();
    },
    {
      maxAttempts: MAX_ATTEMPTS,
      backoffMs: deps.backoffMs ?? ((attempt) => 30_000 * 2 ** (attempt - 1)),
      onFailed: (job, error) => {
        worker.onFailed(job, error);
        const clip = repos.clips.get(job.clipId);
        deps.clipsChanged();
        if (clip) deps.notify({ level: 'error', message: `Не удалось синхронизировать «${clip.title || 'без названия'}» с Google Drive: ${error}` });
      },
    },
  );

  /** Serializes the "is Drive connected?" checks so that enqueue order is deterministic. */
  let pending: Promise<void> = Promise.resolve();
  const whenConnected = (action: () => void, warn: boolean) => {
    pending = pending
      .then(() => deps.auth.isConnected())
      .then((connected) => {
        if (connected) action();
        else if (warn) deps.notify(NOT_CONNECTED);
      })
      .catch(() => undefined);
  };
  const kick = () => void queue.tick().catch(() => undefined);
  const enqueue = (clipId: string) => {
    if (repos.clips.get(clipId)?.syncStatus === 'failed') repos.clips.setSyncStatus(clipId, 'pending');
    queue.enqueue({ clipId }, clipId);
  };
  const enqueueAll = () => {
    queue.retryFailed();
    for (const clip of repos.clips.list()) if (clip.syncStatus !== 'synced') enqueue(clip.id);
    deps.clipsChanged();
    kick();
  };

  return {
    status: () => deps.auth.status(),
    async connect(): Promise<Result<null>> {
      const result = await deps.auth.connect();
      if (result.ok) whenConnected(enqueueAll, false);
      return result;
    },
    disconnect: () => deps.auth.disconnect(),
    onClipSaved(clipId: string): void {
      if (!deps.settings.get().driveAutoSync) return;
      whenConnected(() => {
        enqueue(clipId);
        kick();
      }, false);
    },
    sync(clipId: string): void {
      whenConnected(() => {
        enqueue(clipId);
        deps.clipsChanged();
        kick();
      }, true);
    },
    syncAll(): void {
      whenConnected(enqueueAll, true);
    },
    start(): void {
      queue.recover();
      queue.start(2000);
    },
    stop: () => queue.stop(),
    /** Runs everything that is due right now (used by tests and on demand). */
    async drain(): Promise<void> {
      for (;;) {
        await pending;
        await queue.whenIdle();
        if (!(await queue.tick())) {
          const settled = pending;
          await settled;
          if (settled === pending && !(await queue.tick())) return;
        }
      }
    },
  };
}

export type DriveSync = ReturnType<typeof createDriveSync>;
