import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { openDb } from '../../src/main/db';
import { createClipRepo } from '../../src/service/clipRepo';
import { defaultConfig } from '../../src/service/config';
import { startHttp } from '../../src/service/http';
import { factorySettings } from '../../src/service/profileSettings';
import { ProfileService } from '../../src/service/profiles';
import type { FeedClip } from '../../src/service/types';
import { tmpDir } from '../helpers';
import { driveFixture } from './driveFixture';

const PASSWORD = 'pw';
const FOLDERS = {
  SORT1234567890: { name: 'to_sort', path: 'Мой диск / Работа / to_sort', canAddChildren: true },
  OTHER123456789: { name: 'to_sort', path: 'Мой диск / to_sort', canAddChildren: true },
  READONLY123456: { name: 'чужая', path: '… / чужая', canAddChildren: false },
};

let root: string;
let http: Awaited<ReturnType<typeof startHttp>>;
let base: string;
let clips: ReturnType<typeof createClipRepo>;
let fx: ReturnType<typeof driveFixture>;
let cookie: string;

class FakeRegistry extends EventEmitter {
  list = () => [];
  mode = () => ({ multiStream: false, limit: 1 });
}

const call = (method: string, path: string, body?: unknown, c: string | null = cookie, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { ...(c ? { Cookie: c } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
/** GET /api/drive with headers fetch() would not let through (Host). */
const rawStatus = (headers: Record<string, string>) =>
  new Promise<any>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.port, path: '/api/drive', headers: { Cookie: cookie, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.end();
  });
const status = async () => (await (await call('GET', '/api/drive')).json()) as any;
const keys = () => call('PUT', '/api/drive/credentials', { clientId: 'cid.apps', clientSecret: 'TOP-SECRET' });
/** Signs in: asks for the consent link and plays Google's redirect back. */
const connect = async () => {
  const { url } = (await (await call('POST', '/api/drive/connect', undefined, cookie, { Origin: base })).json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  return call('GET', `/api/drive/callback?state=${state}&code=good`, undefined, null);
};
const takenClip = (id: string): FeedClip => {
  const mp4Path = join(root, `${id}.mp4`);
  writeFileSync(mp4Path, 'video');
  return {
    id, sessionId: 's1', streamer: 'alice', streamId: '42', epoch: 1, startMs: 0, endMs: 1, durationMs: 1, bytes: 5, triggers: ['laugh'],
    confidence: 'normal', score: 4, signals: { chatSpike: 3, laughShare: 1, reactionShare: 0, deltaDb: 0 }, status: 'taken', error: null,
    mp4Path, jsonPath: '', fileDeleted: false, createdAt: '2026-11-17T10:00:00.000Z', statusChangedAt: null, profileId: null, profileName: null,
  };
};

beforeEach(async () => {
  root = tmpDir();
  const webDir = join(root, 'web');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<html>app</html>');
  const db = openDb(':memory:');
  clips = createClipRepo(db);
  fx = driveFixture(db, clips, root, FOLDERS);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  http = await startHttp(
    {
      registry: new FakeRegistry() as any, profiles: new ProfileService(db, factorySettings), clips,
      config: () => ({ ...defaultConfig(root), password: PASSWORD }), webDir, cuttingPaused: () => ({ paused: false, reason: null }), drive: fx.deps,
    },
    0, '127.0.0.1',
  );
  base = `http://127.0.0.1:${http.port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => {
  await fx.sync.idle();
  await http.close();
  vi.restoreAllMocks();
});

it('requires a session on every Drive route but the callback', async () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/drive'], ['PUT', '/api/drive/credentials'], ['POST', '/api/drive/connect'], ['POST', '/api/drive/disconnect'],
    ['GET', '/api/drive/folders?name=to_sort'], ['PUT', '/api/drive/folder'], ['POST', '/api/drive/sync'],
  ];
  for (const [m, p] of routes) expect((await call(m, p, m === 'PUT' ? {} : undefined, null)).status, `${m} ${p}`).toBe(401);
  expect((await call('GET', '/api/drive/callback?state=x&code=y', undefined, null)).status).toBe(400);
});

it('reports an unconfigured Drive with the redirect address of this origin', async () => {
  expect(await status()).toEqual({
    hasCredentials: false, clientId: '', connected: false, email: null, folder: null,
    redirectUri: `${base}/api/drive/callback`, redirectProblem: null,
    sync: { running: false, done: 0, total: 0, failed: 0, pending: 0, lastError: null },
  });
});

it('builds the redirect address from the forwarded protocol and says when Google will refuse it', async () => {
  const r = await rawStatus({ Host: 'clips.example.com', 'X-Forwarded-Proto': 'https' });
  expect([r.redirectUri, r.redirectProblem]).toEqual(['https://clips.example.com/api/drive/callback', null]);
  const ip = await rawStatus({ Host: '192.168.1.5:8080' });
  expect(ip.redirectProblem).toContain('Google принимает адрес возврата');
});

it('stores the keys and never gives the secret back', async () => {
  const r = await keys();
  expect(r.status).toBe(200);
  const body = await r.text();
  expect(JSON.parse(body)).toMatchObject({ hasCredentials: true, clientId: 'cid.apps' });
  expect(body + JSON.stringify(await status())).not.toContain('TOP-SECRET');
  expect(fx.settings.get().clientSecret).toBe('TOP-SECRET');
});

it('validates the keys; an empty secret keeps the stored one only for the same client id', async () => {
  for (const bad of [{}, { clientId: '', clientSecret: 'x' }, { clientId: 'a', clientSecret: 5 }, { clientId: 'a'.repeat(301), clientSecret: 'x' }, { clientId: 'a', clientSecret: '' }]) {
    expect((await call('PUT', '/api/drive/credentials', bad)).status).toBe(400);
  }
  await keys();
  expect((await call('PUT', '/api/drive/credentials', { clientId: 'cid.apps', clientSecret: '' })).status).toBe(200);
  expect(fx.settings.get().clientSecret).toBe('TOP-SECRET');
  expect((await call('PUT', '/api/drive/credentials', { clientId: 'other', clientSecret: '' })).status).toBe(400);
});

it('signs in through the callback without a session cookie and returns to the Drive tab', async () => {
  expect((await call('POST', '/api/drive/connect', undefined, cookie, { Origin: base })).status).toBe(400); // no keys yet
  await keys();
  const back = await connect();
  expect([back.status, back.headers.get('location')]).toEqual([302, '/#drive']);
  expect(await status()).toMatchObject({ connected: true, email: 'user@example.com' });
  expect(JSON.stringify(await status())).not.toMatch(/SECRET/);
});

it('answers a stale, repeated or denied callback with a readable page and stays disconnected', async () => {
  await keys();
  const unknown = await call('GET', '/api/drive/callback?state=nope&code=good', undefined, null);
  expect(unknown.status).toBe(400);
  expect(unknown.headers.get('content-type')).toContain('text/html');
  const page = await unknown.text();
  expect(page).toContain('Ссылка входа устарела');
  expect(page).toContain('href="/#drive"');
  const { url } = (await (await call('POST', '/api/drive/connect', undefined, cookie, { Origin: base })).json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  expect(await (await call('GET', `/api/drive/callback?state=${state}&error=access_denied`, undefined, null)).text()).toContain('Доступ к Google Drive не выдан');
  expect((await call('GET', `/api/drive/callback?state=${state}&code=good`, undefined, null)).status).toBe(400);
  expect((await call('GET', '/api/drive/callback', undefined, null)).status).toBe(400);
  expect((await status()).connected).toBe(false);
});

it('changing the keys signs out', async () => {
  await keys();
  await connect();
  await call('PUT', '/api/drive/credentials', { clientId: 'cid.apps', clientSecret: '' });
  expect((await status()).connected).toBe(true);
  await call('PUT', '/api/drive/credentials', { clientId: 'cid.apps', clientSecret: 'another' });
  expect((await status()).connected).toBe(false);
});

it('finds folders by name and chooses one by id or by link', async () => {
  expect((await call('GET', '/api/drive/folders?name=to_sort')).status).toBe(409);
  await keys();
  await connect();
  expect(await (await call('GET', '/api/drive/folders?name=to_sort')).json()).toEqual([
    { id: 'SORT1234567890', name: 'to_sort', path: 'Мой диск / Работа / to_sort' }, { id: 'OTHER123456789', name: 'to_sort', path: 'Мой диск / to_sort' },
  ]);
  expect((await call('GET', '/api/drive/folders')).status).toBe(400);
  const byId = await call('PUT', '/api/drive/folder', { id: 'SORT1234567890' });
  expect(byId.status).toBe(200);
  expect((await byId.json()).folder).toEqual({ id: 'SORT1234567890', name: 'to_sort', path: 'Мой диск / Работа / to_sort' });
  const byLink = await call('PUT', '/api/drive/folder', { link: 'https://drive.google.com/drive/folders/OTHER123456789?usp=sharing' });
  expect((await byLink.json()).folder.id).toBe('OTHER123456789');
});

it('refuses what is not a folder link, a folder it cannot see and a read-only folder', async () => {
  await keys();
  await connect();
  const put = async (body: unknown) => { const r = await call('PUT', '/api/drive/folder', body); return [r.status, ((await r.json()) as any).error]; };
  expect(await put({ link: 'https://example.com/x' })).toEqual([400, 'Это не ссылка на папку Google Drive']);
  expect(await put({})).toEqual([400, 'Это не ссылка на папку Google Drive']);
  expect(await put({ id: 'MISSING1234567' })).toEqual([404, 'Папка не найдена или к ней нет доступа']);
  expect(await put({ id: 'READONLY123456' })).toEqual([409, 'В эту папку нельзя добавлять файлы']);
  expect((await status()).folder).toBeNull();
});

it('a revoked grant found while choosing a folder signs out and says so', async () => {
  await keys();
  await connect();
  fx.state.failWith = Object.assign(new Error('Invalid Credentials'), { status: 401 });
  const r = await call('PUT', '/api/drive/folder', { id: 'SORT1234567890' });
  expect([r.status, ((await r.json()) as any).error]).toEqual([409, 'Доступ к Google Drive отозван. Подключите аккаунт заново']);
  expect((await status()).connected).toBe(false);
});

it('syncs the taken clips on request and pushes progress and clips over SSE', async () => {
  expect((await call('POST', '/api/drive/sync')).status).toBe(409);
  await keys();
  await connect();
  const noFolder = await call('POST', '/api/drive/sync');
  expect([noFolder.status, ((await noFolder.json()) as any).error]).toEqual([409, 'Выберите папку выгрузки на вкладке «Диск»']);
  await call('PUT', '/api/drive/folder', { id: 'SORT1234567890' });
  clips.insert(takenClip('c1'));
  expect((await status()).sync.pending).toBe(1);

  const events = await fetch(`${base}/api/events`, { headers: { Cookie: cookie } });
  const reader = events.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended: ' + text);
      text += dec.decode(value);
    }
  };
  await until(':');
  const r = await call('POST', '/api/drive/sync');
  expect(r.status).toBe(202);
  expect(await r.json()).toMatchObject({ running: true, total: 1 });
  await until('"running":false');
  await until('event: clip');
  await reader.cancel();
  expect(fx.uploads).toEqual(['alice_c1.mp4']);
  expect(text).toContain('event: drive');
  expect(text).toContain('"drive":{"status":"synced"');
  expect(text).not.toMatch(/SECRET|redirectUri/);
  expect((await status()).sync).toMatchObject({ running: false, done: 1, pending: 0 });
});

it('disconnect forgets the account', async () => {
  await keys();
  await connect();
  expect((await call('POST', '/api/drive/disconnect')).status).toBe(204);
  expect(await status()).toMatchObject({ connected: false, email: null, hasCredentials: true });
});

it('rejects Drive changes from a foreign origin', async () => {
  expect((await call('PUT', '/api/drive/credentials', { clientId: 'a', clientSecret: 'b' }, cookie, { Origin: 'https://evil.example' })).status).toBe(403);
});

it('tells the open pages how many clips wait for Sync as soon as a clip is taken', async () => {
  await keys();
  await connect();
  await call('PUT', '/api/drive/folder', { id: 'SORT1234567890' });
  clips.insert({ ...takenClip('c1'), status: 'new' });
  const events = await fetch(`${base}/api/events`, { headers: { Cookie: cookie } });
  const reader = events.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended: ' + text);
      text += dec.decode(value);
    }
  };
  await until(':');
  expect((await call('POST', '/api/clips/c1/status', { status: 'taken' })).status).toBe(200);
  await until('event: drive');
  await until('"pending":1');
  http.broadcast('clip', { id: 'from-the-janitor' });
  text = '';
  await until('event: drive');
  await reader.cancel();
});
