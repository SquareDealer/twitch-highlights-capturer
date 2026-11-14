import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Repos } from '../db/repos';
import { httpStatus, type DriveClient } from './driveClient';

export interface SyncJob {
  clipId: string;
}

export interface SyncWorkerDeps {
  repos: Repos;
  /** null while Google Drive is not connected. */
  getClient: () => Promise<DriveClient | null>;
  md5File?: (path: string) => Promise<string>;
}

const ROOT_FOLDER = 'TwitchHighlights';

function md5OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Uploads a finished clip (MP4 + markers.json) into TwitchHighlights/<streamer>/<session>/<clip>/ on Drive.
 * Safe to repeat: folders are looked up before being created and files already uploaded with the same
 * content are skipped, so a retry after a failure never produces duplicates.
 */
export class SyncWorker {
  private readonly md5File: (path: string) => Promise<string>;

  constructor(private readonly deps: SyncWorkerDeps) {
    this.md5File = deps.md5File ?? md5OfFile;
  }

  async handle(job: SyncJob): Promise<void> {
    const { repos } = this.deps;
    const clip = repos.clips.get(job.clipId);
    if (!clip) return;
    if (!existsSync(clip.mp4Path) || !existsSync(clip.markersPath)) throw new Error('Файлы клипа не готовы');
    const client = await this.deps.getClient();
    if (!client) throw new Error('Google Drive не подключён');

    try {
      // <library>/<streamer>/<session>/<clip folder> → the same three levels under the Drive root folder
      const chain = [ROOT_FOLDER, ...clip.dir.split(/[\\/]+/).filter(Boolean).slice(-3)];
      let parentId: string | null = null;
      let pathKey = '';
      for (const name of chain) {
        pathKey = pathKey ? `${pathKey}/${name}` : name;
        let id = repos.driveFiles.getFolder(pathKey);
        if (!id) {
          id = await client.ensureFolder(name, parentId);
          repos.driveFiles.setFolder(pathKey, id);
        }
        parentId = id;
      }

      const files = [
        { kind: 'mp4' as const, path: clip.mp4Path, mimeType: 'video/mp4' },
        { kind: 'markers' as const, path: clip.markersPath, mimeType: 'application/json' },
      ];
      for (const file of files) {
        const md5 = await this.md5File(file.path);
        const known = repos.driveFiles.get(clip.id, file.kind);
        if (known && known.md5 === md5) continue;
        const uploaded = await client.uploadFile({ localPath: file.path, name: basename(file.path), parentId: parentId!, mimeType: file.mimeType, existingFileId: known?.driveFileId });
        repos.driveFiles.upsert({ clipId: clip.id, kind: file.kind, driveFileId: uploaded.id, version: uploaded.version, md5, status: 'synced' });
      }
    } catch (e) {
      if (httpStatus(e) === 404) {
        // Something we remembered was deleted in Drive: forget it so the retry rebuilds folders and files.
        repos.driveFiles.clearFolders();
        repos.driveFiles.remove(clip.id);
      }
      throw e;
    }
    repos.clips.setSyncStatus(clip.id, 'synced');
  }

  onFailed(job: SyncJob, _error: string): void {
    if (this.deps.repos.clips.get(job.clipId)) this.deps.repos.clips.setSyncStatus(job.clipId, 'failed');
  }
}
