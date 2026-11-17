import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { EventHub } from '../../src/server/events';
import { NotFoundError, startWebServer, type WebApi } from '../../src/server/http';
import { tmpDir } from '../helpers';

let server: Awaited<ReturnType<typeof startWebServer>>;
let root: string;
let calls: Array<{ group: string; method: string; args: unknown[] }>;
let hotkeys: unknown[];
let events: EventHub;

const api: WebApi = {
  async call(group, method, args) {
    calls.push({ group, method, args });
    if (group === 'nope') throw new NotFoundError('Неизвестный метод');
    if (method === 'boom') throw new Error('сломалось');
    if (method === 'void') return undefined;
    return { echo: args };
  },
  hotkey: (body) => void hotkeys.push(body),
};

beforeEach(async () => {
  root = tmpDir();
  calls = [];
  hotkeys = [];
  events = new EventHub();
  const rendererDir = join(root, 'renderer');
  const draftsDir = join(root, 'drafts');
  mkdirSync(join(rendererDir, 'assets'), { recursive: true });
  mkdirSync(draftsDir);
  writeFileSync(join(rendererDir, 'index.html'), '<html>app</html>');
  writeFileSync(join(rendererDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(draftsDir, 'abc-123.mp4'), Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
  writeFileSync(join(root, 'secret.txt'), 'top secret');
  writeFileSync(join(root, 'thr.sqlite.mp4'), 'db');
  server = await startWebServer({ webDir: rendererDir, draftsDir, api, events });
});
afterEach(() => server.close());

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Raw request: the path is sent verbatim (fetch would normalize `..`). Addressed as `localhost` unless `Host` is given. */
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers: { Host: `localhost:${server.port}`, ...headers }, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (path: string, headers: Record<string, string> = {}) => send('GET', path, headers);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  send('POST', path, { 'Content-Type': 'application/json', Origin: `http://localhost:${server.port}`, ...headers }, typeof body === 'string' ? body : JSON.stringify(body));

test('GET / отдаёт index.html; неизвестный путь без расширения — тоже', async () => {
  expect(server.origin).toBe(`http://localhost:${server.port}`);
  const index = await get('/');
  expect([index.status, index.body, index.headers['content-type']]).toEqual([200, '<html>app</html>', 'text/html; charset=utf-8']);
  expect((await get('/editor/some-route')).body).toBe('<html>app</html>');
  const js = await get('/assets/app.js');
  expect([js.status, js.body]).toEqual([200, 'console.log(1)']);
  expect(String(js.headers['content-type'])).toMatch(/javascript/);
  expect((await get('/assets/missing.js')).status).toBe(404);
});

test('страница приложения отдаётся с CSP: скрипты и фреймы только свои и плеера Twitch', async () => {
  const csp = String((await get('/')).headers['content-security-policy']);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' https://player.twitch.tv");
  expect(csp).toContain('frame-src https://player.twitch.tv');
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(String((await get('/editor/x')).headers['content-security-policy'])).toBe(csp);
});

test('GET /media/drafts/<id>.mp4 с Range: bytes=10-19 → 206, 10 байт, корректный Content-Range', async () => {
  const r = await get('/media/drafts/abc-123.mp4', { Range: 'bytes=10-19' });
  expect(r.status).toBe(206);
  expect(r.body).toBe('abcdefghij');
  expect(r.headers['content-range']).toBe('bytes 10-19/36');
  expect(r.headers['content-length']).toBe('10');
  expect(r.headers['content-type']).toBe('video/mp4');
});

test('открытый Range, суффикс и недостижимый диапазон', async () => {
  expect((await get('/media/drafts/abc-123.mp4', { Range: 'bytes=30-' })).body).toBe('uvwxyz');
  expect((await get('/media/drafts/abc-123.mp4', { Range: 'bytes=-4' })).body).toBe('wxyz');
  expect((await get('/media/drafts/abc-123.mp4', { Range: 'bytes=30-999' })).headers['content-range']).toBe('bytes 30-35/36');
  const bad = await get('/media/drafts/abc-123.mp4', { Range: 'bytes=100-200' });
  expect([bad.status, bad.headers['content-range']]).toEqual([416, 'bytes */36']);
});

test('без Range → 200 и Accept-Ranges: bytes; неизвестный id → 404', async () => {
  const r = await get('/media/drafts/abc-123.mp4?v=2');
  expect([r.status, r.headers['accept-ranges'], r.body.length]).toEqual([200, 'bytes', 36]);
  expect((await get('/media/drafts/nope.mp4')).status).toBe(404);
});

test.each([
  '/media/drafts/..%2F..%2Fthr.sqlite.mp4',
  '/media/drafts/../thr.sqlite.mp4',
  '/media/drafts/a%00b.mp4',
  '/..%2Fsecret.txt',
  '/../secret.txt',
  '/%2e%2e/secret.txt',
  '/assets/..%5C..%5Csecret.txt',
])('обход каталога %s → файл не отдаётся', async (path) => {
  const r = await get(path);
  expect([403, 404]).toContain(r.status);
  expect(r.body).not.toMatch(/top secret|^db$/);
});

test('страница по 127.0.0.1 перенаправляется на localhost (плеер Twitch принимает только parent=localhost)', async () => {
  const r = await get('/editor?x=1', { Host: `127.0.0.1:${server.port}` });
  expect([r.status, r.headers.location]).toEqual([302, `http://localhost:${server.port}/editor?x=1`]);
  expect((await get('/media/drafts/abc-123.mp4', { Host: `127.0.0.1:${server.port}` })).status).toBe(200);
});

test('чужое имя хоста (DNS rebinding) → 403', async () => {
  expect((await get('/', { Host: 'evil.example' })).status).toBe(403);
  expect((await post('/api/rpc/capture/status', [], { Host: `evil.example:${server.port}`, Origin: `http://evil.example:${server.port}` })).status).toBe(403);
});

test('статика: только GET/HEAD; сервер слушает только 127.0.0.1', async () => {
  expect((await send('POST', '/')).status).toBe(405);
  expect(server.address).toBe('127.0.0.1');
});

test('без webDir (режим разработки) отдаются только API и видео', async () => {
  const dev = await startWebServer({ webDir: null, draftsDir: join(root, 'drafts'), api });
  try {
    const reply = (path: string) =>
      new Promise<number>((resolve) => request({ host: '127.0.0.1', port: dev.port, path, headers: { Host: `localhost:${dev.port}` } }, (res) => resolve(res.statusCode!)).end());
    expect(await reply('/')).toBe(404);
    expect(await reply('/media/drafts/abc-123.mp4')).toBe(200);
  } finally {
    await dev.close();
  }
});

describe('API', () => {
  test('POST /api/rpc/<group>/<method> вызывает метод с аргументами и возвращает { value }', async () => {
    const r = await post('/api/rpc/capture/start', ['shroud']);
    expect([r.status, JSON.parse(r.body)]).toEqual([200, { value: { echo: ['shroud'] } }]);
    expect(calls).toEqual([{ group: 'capture', method: 'start', args: ['shroud'] }]);
  });

  test('метод без результата → {}; пустое тело → без аргументов', async () => {
    const r = await post('/api/rpc/capture/void', '');
    expect([r.status, r.body]).toEqual([200, '{}']);
    expect(calls[0]!.args).toEqual([]);
  });

  test('ошибка метода → 500 с текстом; неизвестный метод → 404', async () => {
    const boom = await post('/api/rpc/capture/boom', []);
    expect([boom.status, JSON.parse(boom.body)]).toEqual([500, { error: 'сломалось' }]);
    expect((await post('/api/rpc/nope/x', [])).status).toBe(404);
    expect((await post('/api/rpc/a/b/c', [])).status).toBe(404);
  });

  test('некорректный JSON или аргументы не массивом → 400', async () => {
    expect((await post('/api/rpc/capture/start', '{')).status).toBe(400);
    expect((await post('/api/rpc/capture/start', { channel: 'x' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test.each([
    ['чужой Origin', { Origin: 'https://evil.example' }],
    ['Origin другого порта localhost', { Origin: 'http://localhost:1' }],
    ['без Origin', { Origin: '' }],
    ['межсайтовый запрос', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('%s → 403, метод не вызывается', async (_name, headers) => {
    const h: Record<string, string> = { ...headers };
    const r = await new Promise<Reply>((resolve) => {
      const all: Record<string, string> = { Host: `localhost:${server.port}`, 'Content-Type': 'application/json', Origin: `http://localhost:${server.port}`, ...h };
      if (all.Origin === '') delete all.Origin;
      const req = request({ host: '127.0.0.1', port: server.port, path: '/api/rpc/capture/stop', method: 'POST', headers: all }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: '' }));
      });
      req.end('[]');
    });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test('не JSON (простая форма с другого сайта) → 415; GET → 405', async () => {
    expect((await post('/api/rpc/capture/stop', '[]', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await get('/api/rpc/capture/stop')).status).toBe(405);
    expect(calls).toEqual([]);
  });

  test('POST /api/hotkey передаёт тело и отвечает 204', async () => {
    const r = await post('/api/hotkey', { action: { kind: 'replay' }, wallMs: 5 });
    expect(r.status).toBe(204);
    expect(hotkeys).toEqual([{ action: { kind: 'replay' }, wallMs: 5 }]);
  });

  test('GET /api/events — поток событий; чужой сайт не может его читать', async () => {
    expect((await get('/api/events', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const received = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `localhost:${server.port}` } }, (res) => {
        expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('retry:') && events.size === 1 && !text.includes('event:')) events.send('notice', { level: 'info', message: 'привет' });
          if (text.includes('привет')) {
            req.destroy();
            resolve(text);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(received).toContain('event: notice\ndata: {"level":"info","message":"привет"}\n\n');
  });
});
