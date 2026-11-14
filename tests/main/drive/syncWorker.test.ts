import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip } from '@shared/types';
import { openDb } from '../../../src/main/db';
import { createRepos, type Repos } from '../../../src/main/db/repos';
import type { DriveClient } from '../../../src/main/drive/driveClient';
import { SyncWorker } from '../../../src/main/drive/syncWorker';
import { tmpDir } from '../../helpers';

/** In-memory Drive: a tree of folders and files, counting every mutating call. */
class FakeDrive implements DriveClient {
  nodes = new Map<string, { name: string; parent: string | null; folder: boolean; content?: string; version: number }>();
  calls: string[] = [];
  failUploadOf: string | null = null;
  private seq = 0;

  async ensureFolder(name: string, parentId: string | null) {
    for (const [id, n] of this.nodes) if (n.folder && n.name === name && n.parent === parentId) return id;
    const id = `folder${++this.seq}`;
    this.nodes.set(id, { name, parent: parentId, folder: true, version: 1 });
    this.calls.push(`mkdir ${name}`);
    return id;
  }
  async uploadFile(a: { localPath: string; name: string; parentId: string; mimeType: string; existingFileId?: string }) {
    if (!this.nodes.has(a.parentId)) throw Object.assign(new Error('File not found: parent'), { status: 404 });
    if (this.failUploadOf === a.name) throw new Error('network down');
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(a.localPath, 'utf8');
    const existing = a.existingFileId ? this.nodes.get(a.existingFileId) : undefined;
    if (existing) {
      existing.content = content;
      existing.version++;
      this.calls.push(`update ${a.name}`);
      return { id: a.existingFileId!, version: String(existing.version), md5: `md5:${content}` };
    }
    const id = `file${++this.seq}`;
    this.nodes.set(id, { name: a.name, parent: a.parentId, folder: false, content, version: 1 });
    this.calls.push(`create ${a.name} (${a.mimeType})`);
    return { id, version: '1', md5: `md5:${content}` };
  }
  path(id: string): string {
    const n = this.nodes.get(id)!;
    return n.parent ? `${this.path(n.parent)}/${n.name}` : n.name;
  }
  files() {
    return [...this.nodes].filter(([, n]) => !n.folder).map(([id]) => this.path(id)).sort();
  }
}

let repos: Repos;
let drive: FakeDrive;
let connected: boolean;
let worker: SyncWorker;
let library: string;

function makeClip(id: string, folder: string, slug = 'funny-reaction'): Clip {
  const dir = join(library, 'streamer_name', '987654321_2026-11-14_18-30', folder);
  mkdirSync(dir, { recursive: true });
  const clip: Clip = {
    id, momentId: 'm', sessionId: 's', title: 'Funny reaction', dir, mp4Path: join(dir, `${slug}.mp4`), markersPath: join(dir, 'markers.json'),
    durationMs: 1000, createdAt: '2026-11-14T19:42:00.000Z', syncStatus: 'pending',
  };
  writeFileSync(clip.mp4Path, `video of ${id}`);
  writeFileSync(clip.markersPath, `{"clip":"${id}"}`);
  repos.clips.insert(clip);
  return clip;
}

beforeEach(() => {
  library = join(tmpDir(), 'TwitchHighlights');
  repos = createRepos(openDb(':memory:'));
  drive = new FakeDrive();
  connected = true;
  worker = new SyncWorker({ repos, getClient: async () => (connected ? drive : null) });
});

const CLIP_DIR = 'TwitchHighlights/streamer_name/987654321_2026-11-14_18-30/2026-11-14_19-42_funny-reaction_a42f';

test('создаёт цепочку TwitchHighlights/streamer/сессия/клип и загружает mp4, затем markers.json; клип → synced', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  await worker.handle({ clipId: 'c1' });
  expect(drive.files()).toEqual([`${CLIP_DIR}/funny-reaction.mp4`, `${CLIP_DIR}/markers.json`]);
  expect(drive.calls).toEqual([
    'mkdir TwitchHighlights', 'mkdir streamer_name', 'mkdir 987654321_2026-11-14_18-30', 'mkdir 2026-11-14_19-42_funny-reaction_a42f',
    'create funny-reaction.mp4 (video/mp4)', 'create markers.json (application/json)',
  ]);
  expect(repos.clips.get('c1')!.syncStatus).toBe('synced');
  expect(repos.driveFiles.get('c1', 'mp4')).toMatchObject({ status: 'synced', version: '1' });
});

test('повторная синхронизация без изменений ничего не загружает и не создаёт папок', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  await worker.handle({ clipId: 'c1' });
  drive.calls = [];
  await worker.handle({ clipId: 'c1' });
  expect(drive.calls).toEqual([]);
  expect(drive.files()).toHaveLength(2);
});

test('изменённый markers.json обновляется по existingFileId, mp4 не трогается', async () => {
  const clip = makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  await worker.handle({ clipId: 'c1' });
  drive.calls = [];
  writeFileSync(clip.markersPath, '{"clip":"c1","edited":true}');
  await worker.handle({ clipId: 'c1' });
  expect(drive.calls).toEqual(['update markers.json']);
  expect(drive.files()).toHaveLength(2);
  expect(repos.driveFiles.get('c1', 'markers')!.version).toBe('2');
});

test('второй клип той же сессии переиспользует папки стримера и сессии', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  makeClip('c2', '2026-11-14_19-50_other_b1b2', 'other');
  await worker.handle({ clipId: 'c1' });
  drive.calls = [];
  await worker.handle({ clipId: 'c2' });
  expect(drive.calls).toEqual(['mkdir 2026-11-14_19-50_other_b1b2', 'create other.mp4 (video/mp4)', 'create markers.json (application/json)']);
});

test('сбой после загрузки mp4 → ошибка; повтор загружает только markers.json, дубликата mp4 нет', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  drive.failUploadOf = 'markers.json';
  await expect(worker.handle({ clipId: 'c1' })).rejects.toThrow('network down');
  expect(repos.clips.get('c1')!.syncStatus).toBe('pending');
  drive.failUploadOf = null;
  drive.calls = [];
  await worker.handle({ clipId: 'c1' });
  expect(drive.calls).toEqual(['create markers.json (application/json)']);
  expect(drive.files()).toHaveLength(2);
  expect(repos.clips.get('c1')!.syncStatus).toBe('synced');
});

test('нет одного из файлов → ошибка «Файлы клипа не готовы», в Drive ничего не создано', async () => {
  const clip = makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  rmSync(clip.markersPath);
  await expect(worker.handle({ clipId: 'c1' })).rejects.toThrow('Файлы клипа не готовы');
  expect(drive.nodes.size).toBe(0);
});

test('Drive не подключён → ошибка, статус клипа не synced', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  connected = false;
  await expect(worker.handle({ clipId: 'c1' })).rejects.toThrow('Google Drive не подключён');
  expect(repos.clips.get('c1')!.syncStatus).toBe('pending');
});

test('ошибка сети в uploadFile пробрасывается (очередь сделает backoff); onFailed ставит статус failed', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  drive.failUploadOf = 'funny-reaction.mp4';
  await expect(worker.handle({ clipId: 'c1' })).rejects.toThrow('network down');
  expect(drive.files()).toEqual([]);
  worker.onFailed({ clipId: 'c1' }, 'network down');
  expect(repos.clips.get('c1')!.syncStatus).toBe('failed');
});

test('удалённый клип → задача завершается без ошибки', async () => {
  await expect(worker.handle({ clipId: 'gone' })).resolves.toBeUndefined();
  expect(() => worker.onFailed({ clipId: 'gone' }, 'x')).not.toThrow();
});

test('папка удалена в Drive вручную → ошибка 404 сбрасывает кэш папок, повтор создаёт их заново', async () => {
  makeClip('c1', '2026-11-14_19-42_funny-reaction_a42f');
  await worker.handle({ clipId: 'c1' });
  drive.nodes.clear(); // the user wiped the folder in Drive
  const clip = repos.clips.get('c1')!;
  writeFileSync(clip.markersPath, '{"changed":1}');
  await expect(worker.handle({ clipId: 'c1' })).rejects.toThrow('File not found');
  await worker.handle({ clipId: 'c1' });
  expect(drive.files()).toEqual([`${CLIP_DIR}/funny-reaction.mp4`, `${CLIP_DIR}/markers.json`]);
});
