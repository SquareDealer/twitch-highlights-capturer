import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Result } from '@shared/types';
import { httpStatus, type DriveClient } from '../main/drive/driveClient';
import type { createClipRepo } from './clipRepo';
import type { DriveSettingsStore } from './driveSettings';
import type { FeedClip } from './types';

/** `done`, `total`, `failed`: the current run, or the last one; `pending`: clips waiting for the next run. */
export interface DriveSyncState { running: boolean; done: number; total: number; failed: number; pending: number; lastError: string | null }

export interface DriveSyncDeps {
  clips: ReturnType<typeof createClipRepo>;
  settings: DriveSettingsStore;
  /** null while Google Drive is not connected. */
  getClient(): Promise<DriveClient | null>;
  /** The grant was revoked or expired: forget the token. */
  onAuthLost(): Promise<void>;
  now?: () => Date;
}

export const NO_FOLDER = 'Выберите папку выгрузки на вкладке «Диск»';
export const NOT_CONNECTED = 'Google Drive не подключён';
const AUTH_LOST = 'Доступ к Google Drive отозван. Подключите аккаунт заново';
const FOLDER_GONE = 'Папка выгрузки не найдена на Google Drive. Выберите её заново';
const NO_SPACE = 'На Google Drive закончилось место';
const FILE_GONE = 'Файл клипа не найден на диске';

/** The folder is shared by all channels and flat, so the channel goes into the file name. */
export const driveFileName = (c: Pick<FeedClip, 'streamer' | 'mp4Path'>): string => `${c.streamer}_${basename(c.mp4Path)}`;

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** An error that ends the whole run, as the message to show; null: only this clip failed. */
function fatal(e: unknown): { message: string; authLost: boolean } | null {
  const status = httpStatus(e);
  let dump = text(e);
  try {
    dump += JSON.stringify(e);
  } catch {
    /* circular: the message is enough */
  }
  if (status === 401 || /invalid_grant/i.test(dump)) return { message: AUTH_LOST, authLost: true };
  if (/storageQuotaExceeded/i.test(dump)) return { message: NO_SPACE, authLost: false };
  if (status === 404) return { message: FOLDER_GONE, authLost: false };
  return null;
}

/**
 * Uploads the taken clips into the chosen Drive folder, one at a time, when asked to.
 * Safe to repeat: a clip already in the folder is not queued, and the client reuses a same-named
 * file left by an interrupted attempt. Events: 'state' (DriveSyncState), 'clip' (FeedClip).
 */
export class DriveSync extends EventEmitter {
  private running: Promise<void> | null = null;
  private stopping = false;
  private done = 0;
  private total = 0;
  private failed = 0;
  private lastError: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: DriveSyncDeps) {
    super();
    this.now = deps.now ?? (() => new Date());
  }

  state(): DriveSyncState {
    const folder = this.deps.settings.get().folder;
    return {
      running: this.running !== null, done: this.done, total: this.total, failed: this.failed,
      pending: folder ? this.deps.clips.driveQueueCount(folder.id) : 0, lastError: this.lastError,
    };
  }

  /** Starts a run unless one is going. Whether Drive is connected is found out by the run itself. */
  start(): Result<DriveSyncState> {
    if (this.running) return { ok: true, value: this.state() };
    const folder = this.deps.settings.get().folder;
    if (!folder) return { ok: false, error: NO_FOLDER };
    const queue = this.deps.clips.driveQueue(folder.id);
    this.done = 0;
    this.failed = 0;
    this.total = queue.length;
    this.lastError = null;
    this.stopping = false;
    this.running = this.run(folder.id, queue.map((c) => c.id))
      .catch((e) => {
        this.lastError = text(e);
      })
      .finally(() => {
        this.running = null;
        this.announce();
      });
    this.announce();
    return { ok: true, value: this.state() };
  }

  /** Resolves when the current run has ended (at once when none is going). */
  async idle(): Promise<void> {
    await this.running;
  }

  /** No further clips after the one being uploaded. */
  stop(): void {
    this.stopping = true;
  }

  private announce(): void {
    this.emit('state', this.state());
  }

  private mark(id: string, drive: NonNullable<FeedClip['drive']>): void {
    this.deps.clips.update(id, { drive });
    const updated = this.deps.clips.get(id);
    if (updated) this.emit('clip', updated);
  }

  private async run(folderId: string, ids: string[]): Promise<void> {
    const client = await this.deps.getClient();
    if (!client) {
      this.lastError = NOT_CONNECTED;
      return;
    }
    for (const id of ids) {
      if (this.stopping) return;
      // Read again: the clip may have been un-taken or its file deleted while it waited.
      const clip = this.deps.clips.get(id);
      if (!clip || clip.status !== 'taken' || clip.fileDeleted) {
        this.total = Math.max(this.done, this.total - 1);
        continue;
      }
      const previous = clip.drive?.folderId === folderId ? clip.drive.fileId : null;
      if (!existsSync(clip.mp4Path)) {
        // The file is gone for good: say so on the card and do not queue the clip again.
        this.deps.clips.update(id, { fileDeleted: true });
        this.mark(id, { fileId: previous, folderId, status: 'failed', error: FILE_GONE, syncedAt: null });
        this.failed++;
      } else {
        try {
          const uploaded = await client.uploadFile({
            localPath: clip.mp4Path, name: driveFileName(clip), parentId: folderId, mimeType: 'video/mp4',
            ...(previous ? { existingFileId: previous } : {}),
          });
          this.mark(id, { fileId: uploaded.id, folderId, status: 'synced', error: null, syncedAt: this.now().toISOString() });
        } catch (e) {
          const stop = fatal(e);
          if (stop) {
            this.lastError = stop.message;
            if (stop.authLost) await this.deps.onAuthLost().catch(() => undefined);
            return;
          }
          this.mark(id, { fileId: previous, folderId, status: 'failed', error: text(e), syncedAt: null });
          this.failed++;
        }
      }
      this.done++;
      this.announce();
    }
  }
}
