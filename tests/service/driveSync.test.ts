import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/main/db';
import type { DriveClient } from '../../src/main/drive/driveClient';
import { createClipRepo } from '../../src/service/clipRepo';
import { createDriveSettings } from '../../src/service/driveSettings';
import { driveFileName, DriveSync, type DriveSyncState } from '../../src/service/driveSync';
import type { FeedClip } from '../../src/service/types';
import { tmpDir } from '../helpers';

let dir: string;
let clips: ReturnType<typeof createClipRepo>;
let settings: ReturnType<typeof createDriveSettings>;
let uploads: Array<{ name: string; parentId: string; existingFileId?: string; localPath: string }>;
let fail: (name: string) => unknown;
let connected: boolean;
let authLost: number;
let gate: Promise<void> | null;

const drive: DriveClient = {
  ensureFolder: async () => { throw new Error('not used'); },
  uploadFile: async (a) => {
    if (gate) await gate;
    const err = fail(a.name);
    if (err) throw err;
    uploads.push({ name: a.name, parentId: a.parentId, localPath: a.localPath, ...(a.existingFileId ? { existingFileId: a.existingFileId } : {}) });
    return { id: `drive-${a.name}`, version: '1', md5: '' };
  },
};
const httpError = (status: number, message = `http ${status}`, reason?: string) =>
  Object.assign(new Error(message), { status, ...(reason ? { errors: [{ reason }] } : {}) });

const add = (id: string, over: Partial<FeedClip> = {}, file = true): FeedClip => {
  const mp4Path = join(dir, `2026-11-17_10-00-0${id}_laugh_000${id}.mp4`);
  if (file) writeFileSync(mp4Path, 'video');
  const c: FeedClip = {
    id, sessionId: 's1', streamer: 'gaules', streamId: '42', epoch: 1, startMs: 0, endMs: 1000, durationMs: 1000, bytes: 5,
    triggers: ['laugh'], confidence: 'normal', score: 4, signals: { chatSpike: 3, laughShare: 1, reactionShare: 0, deltaDb: 0 },
    status: 'taken', error: null, mp4Path, jsonPath: '', fileDeleted: false, createdAt: `2026-11-17T10:00:0${id}.000Z`,
    statusChangedAt: null, profileId: null, profileName: null, ...over,
  };
  clips.insert(c);
  return c;
};
const make = () => {
  const s = new DriveSync({ clips, settings, getClient: async () => (connected ? drive : null), onAuthLost: async () => { authLost++; connected = false; }, now: () => new Date('2026-11-17T12:00:00.000Z') });
  const states: DriveSyncState[] = [];
  const changed: string[] = [];
  s.on('state', (st: DriveSyncState) => states.push(st));
  s.on('clip', (c: FeedClip) => changed.push(c.id));
  return { s, states, changed };
};
const run = async (s: DriveSync) => {
  const r = s.start();
  await s.idle();
  return r;
};

beforeEach(() => {
  dir = tmpDir();
  const db = openDb(':memory:');
  clips = createClipRepo(db);
  settings = createDriveSettings(db);
  settings.setFolder({ id: 'F', name: 'to_sort', path: 'Мой диск / to_sort' });
  uploads = [];
  fail = () => null;
  connected = true;
  authLost = 0;
  gate = null;
});

it('names the file after the channel and the clip file', () => {
  expect(driveFileName(add('1'))).toBe('gaules_2026-11-17_10-00-01_laugh_0001.mp4');
});

it('uploads the taken clips, oldest first, straight into the folder, and marks them', async () => {
  add('2');
  add('1');
  add('3', { status: 'new' });
  add('4', { status: 'rejected' });
  const { s, states, changed } = make();
  expect(s.state()).toMatchObject({ running: false, pending: 2 });
  const r = await run(s);
  expect(r).toMatchObject({ ok: true, value: { running: true, total: 2 } });
  expect(uploads.map((u) => [u.name, u.parentId])).toEqual([
    ['gaules_2026-11-17_10-00-01_laugh_0001.mp4', 'F'], ['gaules_2026-11-17_10-00-02_laugh_0002.mp4', 'F'],
  ]);
  expect(clips.get('1')!.drive).toEqual({ fileId: 'drive-gaules_2026-11-17_10-00-01_laugh_0001.mp4', folderId: 'F', status: 'synced', error: null, syncedAt: '2026-11-17T12:00:00.000Z' });
  expect(changed).toEqual(['1', '2']);
  expect(states.at(-1)).toEqual({ running: false, done: 2, total: 2, failed: 0, pending: 0, lastError: null });
  expect(states.some((x) => x.running && x.done === 1)).toBe(true);
});

it('uploads nothing the second time', async () => {
  add('1');
  const { s } = make();
  await run(s);
  await run(s);
  expect(uploads).toHaveLength(1);
});

it('does not start a second run while one is going', async () => {
  add('1');
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const { s } = make();
  s.start();
  expect(s.start()).toMatchObject({ ok: true, value: { running: true } });
  open();
  await s.idle();
  expect(uploads).toHaveLength(1);
});

it('refuses to start without a folder or a connection', () => {
  add('1');
  connected = false;
  const a = make().s;
  settings.setFolder(null);
  expect(a.start()).toEqual({ ok: false, error: 'Выберите папку выгрузки на вкладке «Диск»' });
  expect(a.state().pending).toBe(0);
});
it('stops at once when Drive is not connected', async () => {
  add('1');
  connected = false;
  const { s } = make();
  await run(s);
  expect(s.state()).toMatchObject({ running: false, lastError: 'Google Drive не подключён', done: 0 });
  expect(clips.get('1')!.drive).toBeUndefined();
});

it('marks a clip whose file is gone and carries on', async () => {
  add('1', {}, false);
  add('2');
  const { s } = make();
  await run(s);
  expect(clips.get('1')!.drive).toMatchObject({ status: 'failed', error: 'Файл клипа не найден на диске', fileId: null });
  expect(clips.get('1')!.fileDeleted).toBe(true); // the feed shows «файл удалён» and the clip is not queued again
  expect(clips.get('2')!.drive!.status).toBe('synced');
  expect(s.state()).toMatchObject({ done: 2, failed: 1, pending: 0, lastError: null });
  await run(s);
  expect(s.state()).toMatchObject({ total: 0, failed: 0, pending: 0 });
});

it('a failure of one upload does not stop the rest, and the failed clip goes again next time', async () => {
  add('1');
  add('2');
  fail = (name) => (name.includes('0001') ? new Error('socket hang up') : null);
  const { s } = make();
  await run(s);
  expect(clips.get('1')!.drive).toMatchObject({ status: 'failed', error: 'socket hang up' });
  expect(clips.get('2')!.drive!.status).toBe('synced');
  expect(s.state()).toMatchObject({ failed: 1, pending: 1 });
  fail = () => null;
  await run(s);
  expect(clips.get('1')!.drive).toMatchObject({ status: 'synced', error: null });
  expect(s.state()).toMatchObject({ failed: 0, pending: 0 });
});

it.each([
  [httpError(401), 'Доступ к Google Drive отозван. Подключите аккаунт заново', 1],
  [new Error('invalid_grant'), 'Доступ к Google Drive отозван. Подключите аккаунт заново', 1],
  [httpError(404), 'Папка выгрузки не найдена на Google Drive. Выберите её заново', 0],
  [httpError(403, 'The user has exceeded their Drive storage quota', 'storageQuotaExceeded'), 'На Google Drive закончилось место', 0],
])('stops the whole run on %s', async (err, message, lost) => {
  add('1');
  add('2');
  fail = () => err;
  const { s } = make();
  await run(s);
  expect(s.state()).toMatchObject({ running: false, lastError: message, done: 0 });
  expect(authLost).toBe(lost);
  expect(clips.get('1')!.drive).toBeUndefined();
  expect(clips.get('2')!.drive).toBeUndefined();
  expect(uploads).toEqual([]);
});

it('uploads again into a new folder without reusing the old file id', async () => {
  add('1');
  const { s } = make();
  await run(s);
  settings.setFolder({ id: 'G', name: 'other', path: 'other' });
  expect(s.state().pending).toBe(1);
  await run(s);
  expect(uploads[1]).toMatchObject({ parentId: 'G' });
  expect(uploads[1]!.existingFileId).toBeUndefined();
  expect(clips.get('1')!.drive!.folderId).toBe('G');
});

it('reuses the file id when a failed clip was uploaded to the same folder before', async () => {
  add('1', { drive: { fileId: 'old', folderId: 'F', status: 'failed', error: 'x', syncedAt: null } });
  clips.update('1', { drive: { fileId: 'old', folderId: 'F', status: 'failed', error: 'x', syncedAt: null } });
  const { s } = make();
  await run(s);
  expect(uploads[0]!.existingFileId).toBe('old');
});

it('skips a clip that stopped being taken before its turn', async () => {
  add('1');
  add('2');
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const { s } = make();
  s.start();
  clips.update('2', { status: 'new' });
  open();
  await s.idle();
  expect(uploads).toHaveLength(1);
  expect(clips.get('2')!.drive).toBeUndefined();
});

it('stop() lets the current upload finish and takes no more', async () => {
  add('1');
  add('2');
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const { s } = make();
  s.start();
  await new Promise((r) => setTimeout(r, 10));
  s.stop();
  open();
  await s.idle();
  expect(uploads).toHaveLength(1);
  expect(s.state()).toMatchObject({ running: false, pending: 1 });
});
