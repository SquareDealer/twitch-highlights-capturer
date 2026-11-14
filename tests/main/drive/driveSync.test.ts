import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip, Notice } from '@shared/types';
import { openDb } from '../../../src/main/db';
import { createRepos, type Repos } from '../../../src/main/db/repos';
import type { DriveClient } from '../../../src/main/drive/driveClient';
import { createDriveSync } from '../../../src/main/drive';
import { defaultSettings, SettingsStore } from '../../../src/main/settings';
import { tmpDir } from '../../helpers';

let repos: Repos;
let settings: SettingsStore;
let connected: boolean;
let uploads: string[];
let failUploads: boolean;
let notices: Notice[];
let changed: number;
let root: string;
let drive: ReturnType<typeof createDriveSync>;

const client: DriveClient = {
  ensureFolder: async (name) => `folder:${name}`,
  uploadFile: async (a) => {
    if (failUploads) throw new Error('getaddrinfo ENOTFOUND www.googleapis.com');
    uploads.push(a.name);
    return { id: `id:${a.name}`, version: '1', md5: 'x' };
  },
};

function clip(id: string, syncStatus: Clip['syncStatus'] = 'pending'): Clip {
  const dir = join(root, 'streamer', 'session', id);
  mkdirSync(dir, { recursive: true });
  const c: Clip = { id, momentId: 'm', sessionId: 's', title: id, dir, mp4Path: join(dir, `${id}.mp4`), markersPath: join(dir, 'markers.json'), durationMs: 1, createdAt: `2026-11-14T19:4${id.length}:00.000Z`, syncStatus };
  writeFileSync(c.mp4Path, id);
  writeFileSync(c.markersPath, '{}');
  repos.clips.insert(c);
  return c;
}

beforeEach(() => {
  root = tmpDir();
  repos = createRepos(openDb(':memory:'));
  settings = new SettingsStore(repos.db, defaultSettings({ videos: root, userData: root }));
  connected = true;
  uploads = [];
  failUploads = false;
  notices = [];
  changed = 0;
  drive = createDriveSync({
    repos, settings,
    auth: {
      status: async () => (connected ? { connected: true, email: 'user@example.com' } : { connected: false }),
      isConnected: async () => connected,
      connect: async () => {
        connected = true;
        return { ok: true, value: null };
      },
      disconnect: async () => void (connected = false),
    },
    getClient: async () => (connected ? client : null),
    notify: (n) => notices.push(n),
    clipsChanged: () => changed++,
    backoffMs: () => 0,
  });
});
afterEach(() => drive.stop());

const idle = () => drive.drain();

test('автосинхронизация: сохранённый клип уходит в Drive, статус → synced, UI оповещён', async () => {
  clip('c1');
  drive.onClipSaved('c1');
  await idle();
  expect(uploads).toEqual(['c1.mp4', 'markers.json']);
  expect(repos.clips.get('c1')!.syncStatus).toBe('synced');
  expect(changed).toBeGreaterThan(0);
});

test('автосинхронизация выключена или Drive не подключён → ничего не ставится в очередь', async () => {
  clip('c1');
  settings.set({ driveAutoSync: false });
  drive.onClipSaved('c1');
  await idle();
  settings.set({ driveAutoSync: true });
  connected = false;
  drive.onClipSaved('c1');
  await idle();
  expect(uploads).toEqual([]);
  expect(repos.clips.get('c1')!.syncStatus).toBe('pending');
  expect(notices).toEqual([]);
});

test('ручная синхронизация работает при выключенной автосинхронизации; без подключения — предупреждение', async () => {
  clip('c1');
  settings.set({ driveAutoSync: false });
  drive.sync('c1');
  await idle();
  expect(repos.clips.get('c1')!.syncStatus).toBe('synced');
  connected = false;
  drive.sync('c1');
  drive.syncAll();
  await idle();
  expect(notices).toEqual([
    { level: 'warn', message: 'Google Drive не подключён — откройте «Настройки»' },
    { level: 'warn', message: 'Google Drive не подключён — откройте «Настройки»' },
  ]);
});

test('syncAll ставит все несинхронизированные клипы и повторяет упавшие; уже synced не трогает', async () => {
  clip('aa', 'synced');
  clip('b', 'pending');
  clip('ccc', 'failed');
  drive.syncAll();
  await idle();
  expect(uploads.sort()).toEqual(['b.mp4', 'ccc.mp4', 'markers.json', 'markers.json']);
  expect(repos.clips.list().map((c) => c.syncStatus)).toEqual(['synced', 'synced', 'synced']);
});

test('нет сети: 5 попыток, затем статус failed и одно уведомление; клип остаётся локально; после syncAll догружается', async () => {
  const c = clip('c1');
  failUploads = true;
  drive.onClipSaved('c1');
  await idle();
  expect(repos.clips.get('c1')!.syncStatus).toBe('failed');
  expect(notices).toEqual([{ level: 'error', message: 'Не удалось синхронизировать «c1» с Google Drive: getaddrinfo ENOTFOUND www.googleapis.com' }]);
  const { existsSync } = await import('node:fs');
  expect(existsSync(c.mp4Path)).toBe(true);
  expect((repos.db.prepare("SELECT attempts FROM jobs WHERE type = 'sync'").get() as { attempts: number }).attempts).toBe(5);
  failUploads = false;
  drive.syncAll();
  await idle();
  expect(repos.clips.get('c1')!.syncStatus).toBe('synced');
});

test('connect после успеха запускает синхронизацию накопившихся клипов', async () => {
  connected = false;
  clip('c1');
  drive.onClipSaved('c1');
  expect(await drive.connect()).toEqual({ ok: true, value: null });
  await idle();
  expect(uploads).toEqual(['c1.mp4', 'markers.json']);
  expect(await drive.status()).toEqual({ connected: true, email: 'user@example.com' });
});

test('повторная постановка того же клипа не создаёт вторую задачу', async () => {
  clip('c1');
  drive.sync('c1');
  drive.sync('c1');
  drive.onClipSaved('c1');
  await idle();
  expect(uploads).toEqual(['c1.mp4', 'markers.json']);
});

test('start после перезапуска возвращает прерванную задачу в очередь', async () => {
  clip('c1');
  repos.db.prepare("INSERT INTO jobs (id, type, payload, status, attempts, next_run_at, dedupe_key, created_at) VALUES ('j1', 'sync', ?, 'running', 0, 0, 'c1', 1)").run(JSON.stringify({ clipId: 'c1' }));
  drive.start();
  await idle();
  expect(repos.clips.get('c1')!.syncStatus).toBe('synced');
});
