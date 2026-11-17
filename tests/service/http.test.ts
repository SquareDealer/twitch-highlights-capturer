import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { openDb } from '../../src/main/db';
import { createClipRepo } from '../../src/service/clipRepo';
import { defaultConfig } from '../../src/service/config';
import { startHttp } from '../../src/service/http';
import { settingsFromConfig } from '../../src/service/profileSettings';
import { ProfileService, type Profile } from '../../src/service/profiles';
import type { FeedClip } from '../../src/service/types';
import { tmpDir } from '../helpers';
import { driveFixture } from './driveFixture';

const PASSWORD = 'pw';
const FILE = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

class FakeRegistry extends EventEmitter {
  multi = false;
  start = vi.fn(async (_url: string, _q: string): Promise<any> => ({ ok: true, value: { id: 's1', channel: 'alice' } }));
  probe = vi.fn(async (_url: string): Promise<any> => ({ ok: true, value: { channel: 'alice', qualities: ['720p', 'best'] } }));
  stop = vi.fn(async (_id: string) => {});
  manualClip = vi.fn(async (_id: string): Promise<any> => ({ ok: false, error: 'Эфир не найден' }));
  list = vi.fn(() => [{ id: 's1', channel: 'alice' }]);
  mode = vi.fn(() => ({ multiStream: this.multi, limit: this.multi ? 5 : 1 }));
  setMultiStream = vi.fn((on: boolean): any => {
    this.multi = on;
    return { ok: true, value: null };
  });
  setProfile = vi.fn((_id: string, _profileId: string): any => ({ ok: true, value: { id: 's1', channel: 'alice' } }));
  profileInUse = vi.fn((_id: string) => false);
  tuning = vi.fn((_id: string): any => ({ frames: [], entries: [] }));
}

const clip = (id: string, over: Partial<FeedClip> = {}): FeedClip => ({
  id, sessionId: 's1', streamer: 'alice', streamId: '42', epoch: 1, startMs: 0, endMs: 30000, durationMs: 30000,
  bytes: FILE.length, triggers: ['laugh'], confidence: 'normal', score: 0.8,
  signals: { chatSpike: 3, laughShare: 0.5, reactionShare: 0.1, deltaDb: 6 },
  status: 'new', error: null, mp4Path: '', jsonPath: '/x/y.json', fileDeleted: false,
  createdAt: '2026-11-15T10:00:00.000Z', statusChangedAt: null, profileId: null, profileName: null, ...over,
});

let root: string;
let registry: FakeRegistry;
let clips: ReturnType<typeof createClipRepo>;
let http: Awaited<ReturnType<typeof startHttp>>;
let paused = { paused: false, reason: null as string | null };
let base: string;
let profiles: ProfileService;
let def: Profile;
let drive: ReturnType<typeof driveFixture>['deps'];

beforeEach(async () => {
  root = tmpDir();
  const webDir = join(root, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<html>app</html>');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'config.json'), '{"password":"leak"}');
  writeFileSync(join(root, 'a.mp4'), FILE);
  registry = new FakeRegistry();
  const db = openDb(':memory:');
  clips = createClipRepo(db);
  profiles = new ProfileService(db, () => settingsFromConfig(defaultConfig(root)));
  def = profiles.defaultProfile();
  clips.insert(clip('c-new', { mp4Path: join(root, 'a.mp4'), createdAt: '2026-11-15T10:00:00.000Z' }));
  clips.insert(clip('c-pending', { status: 'pending', createdAt: '2026-11-15T09:00:00.000Z' }));
  clips.insert(clip('c-error', { status: 'error', error: 'x', createdAt: '2026-11-15T08:00:00.000Z' }));
  clips.insert(clip('c-gone', { fileDeleted: true, mp4Path: join(root, 'a.mp4'), createdAt: '2026-11-15T07:00:00.000Z' }));
  paused = { paused: false, reason: null };
  drive = driveFixture(db, clips, root).deps;
  http = await startHttp(
    { registry: registry as any, profiles, clips, config: () => ({ ...defaultConfig(root), password: PASSWORD }), webDir, cuttingPaused: () => paused, drive },
    0,
    '127.0.0.1',
  );
  base = `http://127.0.0.1:${http.port}`;
});
afterEach(() => http.close());

async function login(): Promise<string> {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  expect(r.status).toBe(204);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

async function api(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Raw request: the path is sent verbatim (fetch would normalize `..`). */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: http.port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

it('rejects api calls without a session cookie with 401', async () => {
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/clips'], ['GET', '/api/events'], ['GET', '/media/clips/c-new.mp4'], ['POST', '/api/logout']]) {
    expect((await fetch(`${base}${p}`, { method: m })).status, `${m} ${p}`).toBe(401);
  }
  expect((await api('hl_session=bogus', 'GET', '/api/state')).status).toBe(401);
});

it('logs in with the password and sets an HttpOnly cookie', async () => {
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
  expect(bad.status).toBe(401);
  expect(await bad.json()).toEqual({ error: 'Неверный пароль' });
  const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  expect(ok.status).toBe(204);
  const cookie = ok.headers.get('set-cookie')!;
  expect(cookie).toMatch(/^hl_session=[0-9a-f]{64}/);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  expect(cookie).toContain('Path=/');
  expect((await api(cookie.split(';')[0]!, 'GET', '/api/state')).status).toBe(200);
});

it('logout revokes the session', async () => {
  const c = await login();
  expect((await api(c, 'POST', '/api/logout')).status).toBe(204);
  expect((await api(c, 'GET', '/api/state')).status).toBe(401);
});

it('rate-limits repeated wrong passwords', async () => {
  const attempt = (password: string) =>
    fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 5; i++) expect((await attempt('bad')).status).toBe(401);
  const blocked = await attempt('bad');
  expect(blocked.status).toBe(429);
  expect(((await blocked.json()) as { error: string }).error).toMatch(/Слишком много/);
  expect((await attempt(PASSWORD)).status).toBe(429);
});

it('returns the state with streams, mode and cutting', async () => {
  const c = await login();
  paused = { paused: true, reason: 'Мало места' };
  const r = await api(c, 'GET', '/api/state');
  expect(await r.json()).toEqual({
    streams: [{ id: 's1', channel: 'alice' }],
    mode: { multiStream: false, limit: 1 },
    cutting: { paused: true, reason: 'Мало места' },
    profiles: JSON.parse(JSON.stringify(profiles.list())),
    factorySettings: settingsFromConfig(defaultConfig('')),
  });
});

it('returns a Russian error for a non-twitch link, a VOD link, an empty string and an offline channel', async () => {
  const c = await login();
  registry.probe.mockImplementation(async (url: string) => {
    if (url === 'https://twitch.tv/offline') return { ok: false, error: 'Канал не в эфире' };
    return { ok: false, error: 'Это не ссылка на канал Twitch' };
  });
  for (const url of ['https://example.com/x', 'https://www.twitch.tv/videos/123', '']) {
    const r = await api(c, 'POST', '/api/probe', { url });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Это не ссылка на канал Twitch' });
  }
  const off = await api(c, 'POST', '/api/probe', { url: 'https://twitch.tv/offline' });
  expect(off.status).toBe(400);
  expect(await off.json()).toEqual({ error: 'Канал не в эфире' });
  expect(registry.probe).toHaveBeenCalledTimes(4);
  const missing = await api(c, 'POST', '/api/probe', {});
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'Это не ссылка на канал Twitch' });
});

it('probes a channel', async () => {
  const c = await login();
  const r = await api(c, 'POST', '/api/probe', { url: 'https://twitch.tv/alice' });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ channel: 'alice', qualities: ['720p', 'best'] });
});

it('starts a stream and reports 409 with the limit message', async () => {
  const c = await login();
  const ok = await api(c, 'POST', '/api/streams', { url: 'https://twitch.tv/alice', quality: 'best' });
  expect(ok.status).toBe(201);
  expect(await ok.json()).toEqual({ id: 's1', channel: 'alice' });
  expect(registry.start).toHaveBeenCalledWith('https://twitch.tv/alice', 'best');

  const limit = 'Достигнут лимит одновременных эфиров (1). Остановите один из эфиров или включите режим «несколько эфиров»';
  registry.start.mockResolvedValueOnce({ ok: false, error: limit });
  const r = await api(c, 'POST', '/api/streams', { url: 'https://twitch.tv/bob', quality: 'best' });
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: limit });

  registry.start.mockResolvedValueOnce({ ok: false, error: 'Этот канал уже записывается' });
  expect((await api(c, 'POST', '/api/streams', { url: 'https://twitch.tv/alice', quality: 'best' })).status).toBe(409);

  registry.start.mockResolvedValueOnce({ ok: false, error: 'Это не ссылка на канал Twitch' });
  expect((await api(c, 'POST', '/api/streams', { url: 'nope', quality: 'best' })).status).toBe(400);

  expect((await api(c, 'POST', '/api/streams', { url: 'https://twitch.tv/alice' })).status).toBe(400);
});

it('stops a stream and creates manual clips', async () => {
  const c = await login();
  expect((await api(c, 'DELETE', '/api/streams/s1')).status).toBe(204);
  expect(registry.stop).toHaveBeenCalledWith('s1');
  const bad = await api(c, 'POST', '/api/streams/zz/manual-clip');
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: 'Эфир не найден' });
  registry.manualClip.mockResolvedValueOnce({ ok: true, value: clip('m1', { mp4Path: '/secret/m1.mp4' }) });
  const ok = await api(c, 'POST', '/api/streams/s1/manual-clip');
  expect(ok.status).toBe(201);
  const body = (await ok.json()) as Record<string, unknown>;
  expect(body.id).toBe('m1');
  expect(body).not.toHaveProperty('mp4Path');
  expect(body).not.toHaveProperty('jsonPath');
});

it('switches the mode and reports 409 when refused', async () => {
  const c = await login();
  const ok = await api(c, 'PUT', '/api/mode', { multiStream: true });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ multiStream: true, limit: 5 });
  registry.setMultiStream.mockReturnValueOnce({ ok: false, error: 'Сначала остановите лишние эфиры' });
  const no = await api(c, 'PUT', '/api/mode', { multiStream: false });
  expect(no.status).toBe(409);
  expect(await no.json()).toEqual({ error: 'Сначала остановите лишние эфиры' });
  expect((await api(c, 'PUT', '/api/mode', { multiStream: 'yes' })).status).toBe(400);
});

it('lists clips without file system paths', async () => {
  const c = await login();
  const all = (await (await api(c, 'GET', '/api/clips')).json()) as Record<string, unknown>[];
  expect(all.map((x) => x.id)).toEqual(['c-new', 'c-pending', 'c-error', 'c-gone']);
  for (const x of all) {
    expect(x).not.toHaveProperty('mp4Path');
    expect(x).not.toHaveProperty('jsonPath');
  }
  const filtered = (await (await api(c, 'GET', '/api/clips?status=pending&streamer=alice&limit=5')).json()) as { id: string }[];
  expect(filtered.map((x) => x.id)).toEqual(['c-pending']);
  expect(((await (await api(c, 'GET', '/api/clips?limit=1')).json()) as unknown[]).length).toBe(1);
  expect((await api(c, 'GET', '/api/clips?status=bogus')).status).toBe(400);
});

it('changes a clip status and stores statusChangedAt; concurrent changes both succeed, last one wins', async () => {
  const c = await login();
  const before = Date.now();
  const r = await api(c, 'POST', '/api/clips/c-new/status', { status: 'taken' });
  expect(r.status).toBe(200);
  const body = (await r.json()) as FeedClip;
  expect(body.status).toBe('taken');
  expect(Date.parse(body.statusChangedAt!)).toBeGreaterThanOrEqual(before);
  expect(body).not.toHaveProperty('mp4Path');
  expect(clips.get('c-new')!.statusChangedAt).toBe(body.statusChangedAt);

  const rs = await Promise.all([
    api(c, 'POST', '/api/clips/c-new/status', { status: 'rejected' }),
    api(c, 'POST', '/api/clips/c-new/status', { status: 'new' }),
  ]);
  expect(rs.map((x) => x.status)).toEqual([200, 200]);
  const final = clips.get('c-new')!.status;
  expect(['rejected', 'new']).toContain(final);
  const last = (await rs[1]!.json()) as FeedClip;
  expect(last.status).toBe('new');

  expect((await api(c, 'POST', '/api/clips/nope/status', { status: 'new' })).status).toBe(404);
  expect((await api(c, 'POST', '/api/clips/c-new/status', { status: 'pending' })).status).toBe(400);
});

it('refuses to change the status of a pending or error clip', async () => {
  const c = await login();
  for (const id of ['c-pending', 'c-error']) {
    const r = await api(c, 'POST', `/api/clips/${id}/status`, { status: 'taken' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/[а-яё]/i);
  }
  expect(clips.get('c-pending')!.status).toBe('pending');
});

it('refuses to bring back a rejected clip whose file the janitor deleted, but keeps it changeable to rejected', async () => {
  const c = await login();
  clips.insert(clip('c-deleted', { status: 'rejected', fileDeleted: true }));
  for (const status of ['new', 'taken']) {
    const r = await api(c, 'POST', '/api/clips/c-deleted/status', { status });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('Файл клипа удалён');
  }
  expect(clips.get('c-deleted')!.status).toBe('rejected');
  expect((await api(c, 'POST', '/api/clips/c-deleted/status', { status: 'rejected' })).status).toBe(200);
});

it('serves a clip with Range support and as an attachment when download=1', async () => {
  const c = await login();
  const full = await api(c, 'GET', '/media/clips/c-new.mp4');
  expect(full.status).toBe(200);
  expect(full.headers.get('content-type')).toBe('video/mp4');
  expect(full.headers.get('accept-ranges')).toBe('bytes');
  expect(Buffer.from(await full.arrayBuffer())).toEqual(FILE);
  const part = await api(c, 'GET', '/media/clips/c-new.mp4', undefined, { Range: 'bytes=2-5' });
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe(`bytes 2-5/${FILE.length}`);
  expect(await part.text()).toBe('2345');
  const bad = await api(c, 'GET', '/media/clips/c-new.mp4', undefined, { Range: 'bytes=999-' });
  expect(bad.status).toBe(416);
  const dl = await api(c, 'GET', '/media/clips/c-new.mp4?download=1');
  expect(dl.headers.get('content-disposition')).toBe('attachment; filename="a.mp4"');
  await dl.arrayBuffer();
});

it('returns 404 for the media of a clip whose file was deleted', async () => {
  const c = await login();
  expect((await api(c, 'GET', '/media/clips/c-gone.mp4')).status).toBe(404);
  expect((await api(c, 'GET', '/media/clips/nope.mp4')).status).toBe(404);
  clips.update('c-new', { fileDeleted: false });
  writeFileSync(join(root, 'a.mp4'), FILE);
  clips.insert(clip('c-nofile', { mp4Path: join(root, 'missing.mp4') }));
  expect((await api(c, 'GET', '/media/clips/c-nofile.mp4')).status).toBe(404);
});

it('rejects cross-origin state-changing requests', async () => {
  const c = await login();
  const evil = await api(c, 'POST', '/api/probe', { url: 'https://twitch.tv/alice' }, { Origin: 'http://evil.example' });
  expect(evil.status).toBe(403);
  const same = await api(c, 'POST', '/api/probe', { url: 'https://twitch.tv/alice' }, { Origin: base });
  expect(same.status).toBe(200);
  const login403 = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(login403.status).toBe(403);
  expect((await api(c, 'DELETE', '/api/streams/s1', undefined, { Origin: 'http://evil.example' })).status).toBe(403);
});

it('requires JSON bodies of at most 64 KB', async () => {
  const c = await login();
  const text = await fetch(`${base}/api/probe`, { method: 'POST', headers: { Cookie: c, 'Content-Type': 'text/plain' }, body: '{"url":"x"}' });
  expect(text.status).toBe(415);
  const big = await fetch(`${base}/api/probe`, {
    method: 'POST',
    headers: { Cookie: c, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'x'.repeat(70 * 1024) }),
  });
  expect(big.status).toBe(413);
  const broken = await fetch(`${base}/api/probe`, { method: 'POST', headers: { Cookie: c, 'Content-Type': 'application/json' }, body: '{oops' });
  expect(broken.status).toBe(400);
});

it('pushes clip and streams updates over SSE', async () => {
  const c = await login();
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: c } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended: ' + text);
      text += dec.decode(value);
    }
  };
  await until(':'); // connection comment
  registry.emit('streams', [{ id: 's1' }]);
  registry.emit('clip', clip('c-sse', { mp4Path: '/secret/x.mp4' }));
  registry.emit('notice', { level: 'info', message: 'Привет' });
  http.broadcast('cutting', { paused: true, reason: 'r' });
  await until('event: cutting');
  await until('"reason":"r"');
  expect(text).toContain('event: streams\ndata: [{"id":"s1"}]\n\n');
  expect(text).toContain('event: clip\n');
  expect(text).toContain('"id":"c-sse"');
  expect(text).not.toContain('/secret');
  expect(text).toContain('event: notice');
  await reader.cancel();
});

it('serves the web app with a CSP and falls back to index.html', async () => {
  const idx = await raw('/');
  expect(idx.status).toBe(200);
  expect(idx.body).toBe('<html>app</html>');
  expect(idx.headers['content-security-policy']).toBe(
    "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self'; object-src 'none'; base-uri 'none'",
  );
  expect((await raw('/assets/app.js')).body).toBe('console.log(1)');
  const spa = await raw('/some/route');
  expect(spa.body).toBe('<html>app</html>');
  expect((await raw('/assets/missing.js')).status).toBe(404);
  expect((await raw('/api/nope')).status).toBe(401);
});

it('does not serve files outside webDir', async () => {
  for (const p of ['/../config.json', '/../../config.json', '/%2e%2e/config.json', '/..%2fconfig.json', '/assets/..%2f..%2fconfig.json', '/%00']) {
    const r = await raw(p);
    expect([400, 403, 404], p).toContain(r.status);
    expect(r.body).not.toContain('leak');
  }
});

it('returns 400 for malformed percent-escapes in route params', async () => {
  const c = await login();
  expect((await api(c, 'DELETE', '/api/streams/%E0')).status).toBe(400);
  expect((await api(c, 'POST', '/api/streams/%E0/manual-clip')).status).toBe(400);
  const r = await api(c, 'POST', '/api/clips/%E0/status', { status: 'new' });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toMatch(/[а-яё]/i);
});

it('compares Origin and Host after normalization', async () => {
  const c = await login();
  const body = { url: 'https://twitch.tv/alice' };
  const mixed = await api(c, 'POST', '/api/probe', body, { Origin: `http://127.0.0.1:${http.port}`.toUpperCase().replace('HTTP', 'http') });
  expect(mixed.status).toBe(200);
  const bad = await api(c, 'POST', '/api/probe', body, { Origin: 'not a url' });
  expect(bad.status).toBe(403);
  // default port: Origin without a port equals Host with :80 (and https :443)
  const viaRaw = (origin: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: http.port, path: '/api/probe', method: 'POST', setHost: false, headers: { Host: host, Origin: origin, Cookie: c, 'Content-Type': 'application/json', 'Content-Length': String(JSON.stringify(body).length) } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  expect(await viaRaw('http://Example.com', 'example.com:80')).toBe(200);
  expect(await viaRaw('https://example.com', 'EXAMPLE.com:443')).toBe(200);
  expect(await viaRaw('http://example.com', 'example.com:8080')).toBe(403);
});

it('closes SSE streams of a token on logout, but not of other tokens', async () => {
  const a = await login();
  const b = await login();
  const ra = await fetch(`${base}/api/events`, { headers: { Cookie: a } });
  const rb = await fetch(`${base}/api/events`, { headers: { Cookie: b } });
  const readerA = ra.body!.getReader();
  const readerB = rb.body!.getReader();
  await readerA.read();
  await readerB.read();
  expect((await api(a, 'POST', '/api/logout')).status).toBe(204);
  while (!(await readerA.read()).done);
  registry.emit('notice', { level: 'info', message: 'ещё жив' });
  const { value } = await readerB.read();
  expect(new TextDecoder().decode(value)).toContain('ещё жив');
  await readerB.cancel();
});

it('closes SSE streams whose token is no longer valid at the ping', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
  try {
    const local = await startHttp(
      { registry: registry as any, profiles, clips, config: () => ({ ...defaultConfig(root), password: PASSWORD }), webDir: join(root, 'web'), cuttingPaused: () => paused, drive },
      0,
      '127.0.0.1',
    );
    try {
      const r = await fetch(`http://127.0.0.1:${local.port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
      const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
      const res = await fetch(`http://127.0.0.1:${local.port}/api/events`, { headers: { Cookie: cookie } });
      const reader = res.body!.getReader();
      await reader.read();
      vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
      vi.advanceTimersByTime(20_000);
      while (!(await reader.read()).done);
    } finally {
      await local.close();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('rejects an oversized Content-Length with 413 on any route', async () => {
  const send = (method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: http.port, path, method, headers: { 'Content-Length': String(70 * 1024), ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end(); // the declared body is never sent: the limit is enforced from the header
    });
  const c = await login();
  expect(await send('POST', '/api/probe')).toBe(413); // unauthenticated
  expect(await send('PUT', '/api/state', { Cookie: c })).toBe(413);
  expect(await send('PATCH', '/index.html')).toBe(413); // would be 405
  expect(await send('POST', '/nope')).toBe(413);
});

it('cuts off a chunked body on a route that does not read it', async () => {
  const c = await login();
  const closed = await new Promise<boolean>((resolve) => {
    const req = request({ host: '127.0.0.1', port: http.port, path: '/api/state', method: 'POST', headers: { Cookie: c, 'Transfer-Encoding': 'chunked' } }, (res) => res.resume());
    req.on('error', () => {});
    req.on('close', () => resolve(true));
    const timer = setTimeout(() => resolve(false), 3000);
    req.on('close', () => clearTimeout(timer));
    const chunk = Buffer.alloc(16 * 1024, 97);
    for (let i = 0; i < 8; i++) req.write(chunk); // never ended: only the server can close the connection
  });
  expect(closed).toBe(true);
});

describe('profiles', () => {
  it('lists, creates, updates and deletes profiles', async () => {
    const c = await login();
    const list = async () => (await (await api(c, 'GET', '/api/profiles')).json()) as Profile[];
    const first = await api(c, 'GET', '/api/profiles');
    expect(first.status).toBe(200);
    expect((await list()).map((p) => p.id)).toEqual([def.id]);

    const created = await api(c, 'POST', '/api/profiles', { name: 'Тихий', copyFrom: def.id });
    expect(created.status).toBe(201);
    const p = (await created.json()) as Profile;
    expect(p).toMatchObject({ name: 'Тихий', isDefault: false });
    expect((await list()).map((x) => x.name)).toEqual(['По умолчанию', 'Тихий']);

    const settings = structuredClone(p.settings);
    settings.cut.preRollMs = 7000;
    const upd = await api(c, 'PUT', `/api/profiles/${p.id}`, { name: 'Громкий', settings });
    expect(upd.status).toBe(200);
    expect(await upd.json()).toMatchObject({ id: p.id, name: 'Громкий', settings: { cut: { preRollMs: 7000 } } });
    expect((await list()).find((x) => x.id === p.id)!.name).toBe('Громкий');

    const del = await api(c, 'DELETE', `/api/profiles/${p.id}`);
    expect(del.status).toBe(204);
    expect((await list()).map((x) => x.id)).toEqual([def.id]);
  });

  it('answers creation errors with their status', async () => {
    const c = await login();
    const dup = await api(c, 'POST', '/api/profiles', { name: 'по умолчанию' });
    expect(dup.status).toBe(409);
    const ghost = await api(c, 'POST', '/api/profiles', { name: 'Новый', copyFrom: 'nope' });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: 'Профиль не найден' });
  });

  it('answers validation errors with the field path', async () => {
    const c = await login();
    const bad = structuredClone(def.settings);
    bad.detector.chat.windowS = 0;
    const r = await api(c, 'PUT', `/api/profiles/${def.id}`, { settings: bad });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: '«Окно подсчёта сообщений»: допустимо от 1 до 60', path: 'detector.chat.windowS' });
  });

  it('refuses to delete a profile used by a running stream', async () => {
    const c = await login();
    const p = profiles.create('Занятый').ok ? profiles.list().find((x) => x.name === 'Занятый')! : def;
    registry.profileInUse.mockReturnValue(true);
    const r = await api(c, 'DELETE', `/api/profiles/${p.id}`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'Профиль используется идущим эфиром' });
    expect(profiles.get(p.id)).not.toBeNull();
  });

  it('refuses to delete the default profile and unknown ids', async () => {
    const c = await login();
    expect((await api(c, 'DELETE', `/api/profiles/${def.id}`)).status).toBe(409);
    expect((await api(c, 'DELETE', '/api/profiles/nope')).status).toBe(404);
    expect((await api(c, 'PUT', '/api/profiles/nope', { name: 'x' })).status).toBe(404);
  });

  it('passes profileId to start and rejects a non-string one', async () => {
    const c = await login();
    const ok = await api(c, 'POST', '/api/streams', { url: 'https://twitch.tv/alice', quality: 'best', profileId: 'p2' });
    expect(ok.status).toBe(201);
    expect(registry.start).toHaveBeenCalledWith('https://twitch.tv/alice', 'best', 'p2');
    const bad = await api(c, 'POST', '/api/streams', { url: 'https://twitch.tv/alice', quality: 'best', profileId: 5 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Некорректный запрос' });
  });

  it('switches the profile of a stream', async () => {
    const c = await login();
    const ok = await api(c, 'PUT', '/api/streams/s1/profile', { profileId: 'p2' });
    expect(ok.status).toBe(200);
    expect(registry.setProfile).toHaveBeenCalledWith('s1', 'p2');
    registry.setProfile.mockReturnValueOnce({ ok: false, error: 'Эфир не найден' });
    expect((await api(c, 'PUT', '/api/streams/zz/profile', { profileId: 'p2' })).status).toBe(404);
    registry.setProfile.mockReturnValueOnce({ ok: false, error: 'Профиль не найден' });
    expect((await api(c, 'PUT', '/api/streams/s1/profile', { profileId: 'zz' })).status).toBe(400);
    expect((await api(c, 'PUT', '/api/streams/s1/profile', { profileId: 5 })).status).toBe(400);
  });

  it('serves the tuning history', async () => {
    const c = await login();
    const ok = await api(c, 'GET', '/api/streams/s1/tuning');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ frames: [], entries: [] });
    registry.tuning.mockReturnValueOnce(null);
    const gone = await api(c, 'GET', '/api/streams/zz/tuning');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'Эфир не найден' });
  });

  it('includes profiles in /api/state and the probe profileId passes through', async () => {
    const c = await login();
    const s = (await (await api(c, 'GET', '/api/state')).json()) as { profiles: Profile[] };
    expect(s.profiles.map((p) => p.id)).toEqual([def.id]);
    registry.probe.mockResolvedValueOnce({ ok: true, value: { channel: 'alice', qualities: ['best'], profileId: def.id } });
    const r = await api(c, 'POST', '/api/probe', { url: 'https://twitch.tv/alice' });
    expect(await r.json()).toMatchObject({ profileId: def.id });
  });

  it('broadcasts profiles and tuning over SSE', async () => {
    const c = await login();
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: c } });
    const reader = res.body!.getReader();
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
    expect((await api(c, 'PUT', `/api/profiles/${def.id}`, { name: 'Основной' })).status).toBe(200);
    await until('event: profiles');
    await until('"name":"Основной"');
    registry.emit('tuning', { streamId: 's1', entry: { t: 1 } });
    await until('event: tuning\ndata: {"streamId":"s1","entry":{"t":1}}\n\n');
    await reader.cancel();
  });

  it('requires login for the profile routes', async () => {
    for (const [m, p] of [['GET', '/api/profiles'], ['POST', '/api/profiles'], ['PUT', `/api/profiles/${def.id}`], ['DELETE', `/api/profiles/${def.id}`], ['PUT', '/api/streams/s1/profile'], ['GET', '/api/streams/s1/tuning']]) {
      expect((await fetch(`${base}${p}`, { method: m })).status, `${m} ${p}`).toBe(401);
    }
  });

  it('rejects profile writes from a foreign origin', async () => {
    const c = await login();
    const evil = { Origin: 'http://evil' };
    expect((await api(c, 'POST', '/api/profiles', { name: 'x' }, evil)).status).toBe(403);
    expect((await api(c, 'PUT', `/api/profiles/${def.id}`, { name: 'x' }, evil)).status).toBe(403);
    expect((await api(c, 'DELETE', `/api/profiles/${def.id}`, undefined, evil)).status).toBe(403);
    expect(profiles.list()).toHaveLength(1);
  });
});
