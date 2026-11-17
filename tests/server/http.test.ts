import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { startLocalServer } from '../../src/server/http';
import { tmpDir } from '../helpers';

let server: Awaited<ReturnType<typeof startLocalServer>>;
let root: string;

beforeEach(async () => {
  root = tmpDir();
  const rendererDir = join(root, 'renderer');
  const draftsDir = join(root, 'drafts');
  mkdirSync(join(rendererDir, 'assets'), { recursive: true });
  mkdirSync(draftsDir);
  writeFileSync(join(rendererDir, 'index.html'), '<html>app</html>');
  writeFileSync(join(rendererDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(draftsDir, 'abc-123.mp4'), Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
  writeFileSync(join(root, 'secret.txt'), 'top secret');
  writeFileSync(join(root, 'thr.sqlite.mp4'), 'db');
  server = await startLocalServer({ rendererDir, draftsDir });
});
afterEach(() => server.close());

/** Raw request: the path is sent verbatim (fetch would normalize `..`). */
function get(path: string, headers: Record<string, string> = {}, host = '127.0.0.1'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: server.port, path, headers, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

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

test('только GET/HEAD; сервер слушает только 127.0.0.1', async () => {
  const post = await new Promise<number>((resolve) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: '/', method: 'POST' }, (res) => resolve(res.statusCode!));
    req.end();
  });
  expect(post).toBe(405);
  expect(server.address).toBe('127.0.0.1');
});
