import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuth2Client } from 'google-auth-library';
import { join } from 'node:path';
import { createDriveClient, type DriveRequest } from '../../../src/main/drive/driveClient';
import { tmpDir } from '../../helpers';

type Call = { method: string; url: string; params?: Record<string, string>; data?: unknown; headers?: Record<string, string> };
let calls: Call[];
let respond: (c: Call) => { data?: unknown; headers?: Record<string, string> };
const request: DriveRequest = async (opts) => {
  const call: Call = { method: opts.method ?? 'GET', url: opts.url, params: opts.params, data: opts.data, headers: opts.headers };
  calls.push(call);
  const body = opts.data as { on?: (e: string, cb: () => void) => void; destroy?: () => void } | undefined;
  if (typeof body?.destroy === 'function') {
    body.on?.('error', () => {}); // a real HTTP layer would consume the upload stream
    body.destroy();
  }
  const r = respond(call);
  return { data: r.data ?? {}, headers: r.headers ?? {} };
};
beforeEach(() => {
  calls = [];
});

test('ensureFolder возвращает существующую папку и ничего не создаёт', async () => {
  respond = () => ({ data: { files: [{ id: 'f1' }] } });
  expect(await createDriveClient(request).ensureFolder("it's", 'parent1')).toBe('f1');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.params!.q).toBe("name = 'it\\'s' and 'parent1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
});

test('ensureFolder создаёт папку, когда её нет; корень ищется в root', async () => {
  respond = (c) => (c.method === 'GET' ? { data: { files: [] } } : { data: { id: 'new1' } });
  expect(await createDriveClient(request).ensureFolder('TwitchHighlights', null)).toBe('new1');
  expect(calls[0]!.params!.q).toContain("'root' in parents");
  expect(calls[1]).toMatchObject({ method: 'POST', data: { name: 'TwitchHighlights', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] } });
});

test('uploadFile: resumable-сессия, затем PUT содержимого; возвращает id, версию и md5', async () => {
  const file = join(tmpDir(), 'clip.mp4');
  writeFileSync(file, 'x'.repeat(1234));
  respond = (c) => (c.method === 'GET' ? { data: { files: [] } } : c.method === 'POST' ? { headers: { location: 'https://upload.example/session1' } } : { data: { id: 'file1', version: '3', md5Checksum: 'abc' } });
  const out = await createDriveClient(request).uploadFile({ localPath: file, name: 'clip.mp4', parentId: 'p1', mimeType: 'video/mp4' });
  expect(out).toEqual({ id: 'file1', version: '3', md5: 'abc' });
  calls.shift(); // the lookup for an already uploaded copy
  expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files', data: { name: 'clip.mp4', parents: ['p1'] } });
  expect(calls[0]!.params).toMatchObject({ uploadType: 'resumable' });
  expect(calls[0]!.headers).toMatchObject({ 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': '1234' });
  expect(calls[1]).toMatchObject({ method: 'PUT', url: 'https://upload.example/session1' });
  expect(calls[1]!.headers).toMatchObject({ 'Content-Length': '1234', 'Content-Type': 'video/mp4' });
});

test('uploadFile с existingFileId обновляет файл через PATCH и не передаёт parents', async () => {
  const file = join(tmpDir(), 'markers.json');
  writeFileSync(file, '{}');
  respond = (c) => (c.method === 'PATCH' ? { headers: { location: 'https://upload.example/s2' } } : { data: { id: 'file1', version: '4', md5Checksum: 'def' } });
  await createDriveClient(request).uploadFile({ localPath: file, name: 'markers.json', parentId: 'p1', mimeType: 'application/json', existingFileId: 'file1' });
  expect(calls[0]).toMatchObject({ method: 'PATCH', url: 'https://www.googleapis.com/upload/drive/v3/files/file1', data: { name: 'markers.json' } });
});

test('uploadFile: 404 при обновлении (файл удалён в Drive) → создаётся заново', async () => {
  const file = join(tmpDir(), 'markers.json');
  writeFileSync(file, '{}');
  respond = (c) => {
    if (c.method === 'PATCH') throw Object.assign(new Error('File not found'), { status: 404 });
    if (c.method === 'GET') return { data: { files: [] } };
    return c.method === 'POST' ? { headers: { location: 'https://upload.example/s3' } } : { data: { id: 'file2', version: '1', md5Checksum: 'x' } };
  };
  const out = await createDriveClient(request).uploadFile({ localPath: file, name: 'markers.json', parentId: 'p1', mimeType: 'application/json', existingFileId: 'gone' });
  expect(out.id).toBe('file2');
  expect(calls.map((c) => c.method)).toEqual(['PATCH', 'GET', 'POST', 'PUT']);
});

test('uploadFile без Location в ответе → понятная ошибка', async () => {
  const file = join(tmpDir(), 'a.json');
  writeFileSync(file, '{}');
  respond = (c) => (c.method === 'GET' ? { data: { files: [] } } : {});
  await expect(createDriveClient(request).uploadFile({ localPath: file, name: 'a.json', parentId: 'p', mimeType: 'application/json' })).rejects.toThrow('Google Drive не выдал адрес загрузки');
});

test('реальный HTTP-слой google-auth-library: файл уходит потоком с Authorization и верной длиной', async () => {
  const file = join(tmpDir(), 'clip.mp4');
  const content = Buffer.alloc(300_000, 'v');
  writeFileSync(file, content);
  const received: { auth?: string; length?: string; type?: string; body?: Buffer } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      Object.assign(received, { auth: req.headers.authorization, length: req.headers['content-length'], type: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'file9', version: '2', md5Checksum: 'm' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const location = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload/session`;
  const oauth = new OAuth2Client({ clientId: 'id', clientSecret: 'secret' });
  oauth.setCredentials({ access_token: 'test-access-token', expiry_date: Date.now() + 3_600_000 });
  const real = oauth.request.bind(oauth) as unknown as DriveRequest;
  // Opening the session would hit googleapis.com; only the byte transfer goes through the real client.
  const mixed: DriveRequest = (opts) => (opts.method === 'PUT' ? real(opts) : Promise.resolve({ data: { files: [] }, headers: new Headers({ location }) }));
  try {
    const out = await createDriveClient(mixed).uploadFile({ localPath: file, name: 'clip.mp4', parentId: 'p', mimeType: 'video/mp4' });
    expect(out).toEqual({ id: 'file9', version: '2', md5: 'm' });
    expect(received.auth).toBe('Bearer test-access-token');
    expect(received.length).toBe('300000');
    expect(received.type).toBe('video/mp4');
    expect(received.body!.equals(content)).toBe(true);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('uploadFile: файл с таким именем уже лежит в папке (ответ прошлой загрузки потерялся) → обновляется он, дубликат не создаётся', async () => {
  const file = join(tmpDir(), 'clip.mp4');
  writeFileSync(file, 'data');
  respond = (c) => {
    if (c.method === 'GET') return { data: { files: [{ id: 'orphan1' }] } };
    return c.method === 'PATCH' ? { headers: { location: 'https://upload.example/s4' } } : { data: { id: 'orphan1', version: '2', md5Checksum: 'y' } };
  };
  const out = await createDriveClient(request).uploadFile({ localPath: file, name: "it's.mp4", parentId: 'p1', mimeType: 'video/mp4' });
  expect(out.id).toBe('orphan1');
  expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'PUT']);
  expect(calls[0]!.params!.q).toBe("name = 'it\\'s.mp4' and 'p1' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false");
  expect(calls[1]!.url).toBe('https://www.googleapis.com/upload/drive/v3/files/orphan1');
});
