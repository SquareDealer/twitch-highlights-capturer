import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { end, MIME, sendFile } from '../main/server';
import { Sessions } from './auth';
import type { createClipRepo } from './clipRepo';
import type { ServiceConfig } from './config';
import type { StreamRegistry } from './streams';
import type { ClipStatus, FeedClip } from './types';

export interface HttpDeps {
  registry: StreamRegistry;
  clips: ReturnType<typeof createClipRepo>;
  config: () => ServiceConfig;
  webDir: string;
  cuttingPaused: () => { paused: boolean; reason: string | null };
}

const COOKIE = 'hl_session';
const MAX_BODY = 64 * 1024;
const PING_MS = 20_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self'; object-src 'none'; base-uri 'none'";
const NOT_A_CHANNEL = 'Это не ссылка на канал Twitch';
const BAD_REQUEST = 'Некорректный запрос';
const CHANGEABLE: ClipStatus[] = ['new', 'taken', 'rejected'];
const ALL_STATUSES: ClipStatus[] = ['pending', 'new', 'taken', 'rejected', 'error'];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Registry refusals that are conflicts with the current state rather than bad input. */
const isConflict = (error: string) => /^(Достигнут лимит|Этот канал уже|Сначала остановите)/.test(error);

/** Decodes a route parameter; a malformed escape such as %E0 is a client error, not a crash. */
function decodeParam(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    throw new HttpError(400, BAD_REQUEST);
  }
}

export const publicClip = ({ mp4Path: _m, jsonPath: _j, ...rest }: FeedClip) => rest;

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length), 'Cache-Control': 'no-store' });
  res.end(data);
}
const fail = (res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) => {
  const data = Buffer.from(JSON.stringify({ error }));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length), ...headers });
  res.end(data);
};

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
  if (!hasBody) return {};
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Ожидается Content-Type: application/json');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      req.resume();
      throw new HttpError(413, 'Слишком большой запрос');
    }
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, BAD_REQUEST);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, BAD_REQUEST);
  return parsed as Record<string, unknown>;
}

/** Compares Origin and Host after normalization (case, default port); a malformed value counts as foreign. */
function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    const o = new URL(origin);
    return host !== undefined && o.host === new URL(`${o.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

/** Routes whose handlers read a JSON body. */
const readsBody = (method: string, path: string) =>
  (method === 'POST' && /^\/api\/(login|probe|streams)$/.test(path)) ||
  (method === 'PUT' && path === '/api/mode') ||
  (method === 'POST' && /^\/api\/clips\/[^/]+\/status$/.test(path));

export async function startHttp(
  deps: HttpDeps,
  port: number,
  host = '0.0.0.0',
): Promise<{ port: number; close(): Promise<void>; broadcast(event: string, data: unknown): void }> {
  const sessions = new Sessions(deps.config().password);
  const webRoot = resolve(deps.webDir);
  const failures = new Map<string, number[]>();
  const sse = new Map<ServerResponse, string>();

  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse.keys()) res.write(frame);
  };

  const onStreams = (v: unknown) => broadcast('streams', v);
  const onClip = (c: FeedClip) => broadcast('clip', publicClip(c));
  const onNotice = (v: unknown) => broadcast('notice', v);
  deps.registry.on('streams', onStreams);
  deps.registry.on('clip', onClip);
  deps.registry.on('notice', onNotice);
  const closeStream = (res: ServerResponse): void => {
    sse.delete(res);
    res.end();
  };
  const pinger = setInterval(() => {
    for (const [res, token] of sse) {
      if (sessions.valid(token)) res.write(': ping\n\n');
      else closeStream(res);
    }
  }, PING_MS);
  pinger.unref();

  const recentFailures = (addr: string, now: number): number[] => {
    const list = (failures.get(addr) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (list.length) failures.set(addr, list);
    else failures.delete(addr);
    return list;
  };

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method!;
    const path = url.pathname;

    if (method === 'POST' && path === '/api/login') {
      const body = await readJson(req);
      const addr = req.socket.remoteAddress ?? '';
      const now = Date.now();
      if (recentFailures(addr, now).length >= LOGIN_MAX_FAILURES) {
        return fail(res, 429, 'Слишком много попыток входа. Подождите минуту', { 'Retry-After': '60' });
      }
      const token = typeof body.password === 'string' ? sessions.login(body.password) : null;
      if (!token) {
        failures.set(addr, [...recentFailures(addr, now), now]);
        return fail(res, 401, 'Неверный пароль');
      }
      return end(res, 204, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}` });
    }

    const token = cookieToken(req);
    if (!sessions.valid(token)) return fail(res, 401, 'Требуется вход');

    if (method === 'POST' && path === '/api/logout') {
      sessions.logout(token!);
      for (const [stream, t] of sse) if (t === token) closeStream(stream);
      return end(res, 204, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (method === 'GET' && path === '/api/state') {
      return json(res, 200, { streams: deps.registry.list(), mode: deps.registry.mode(), cutting: deps.cuttingPaused() });
    }

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sse.set(res, token!);
      res.on('close', () => sse.delete(res));
      return;
    }

    if (method === 'POST' && path === '/api/probe') {
      const body = await readJson(req);
      if (typeof body.url !== 'string') return fail(res, 400, NOT_A_CHANNEL);
      const r = await deps.registry.probe(body.url);
      return r.ok ? json(res, 200, r.value) : fail(res, 400, r.error);
    }

    if (method === 'POST' && path === '/api/streams') {
      const body = await readJson(req);
      if (typeof body.url !== 'string' || typeof body.quality !== 'string' || !body.quality) return fail(res, 400, BAD_REQUEST);
      const r = await deps.registry.start(body.url, body.quality);
      return r.ok ? json(res, 201, r.value) : fail(res, isConflict(r.error) ? 409 : 400, r.error);
    }

    let m = /^\/api\/streams\/([^/]+)$/.exec(path);
    if (m && method === 'DELETE') {
      await deps.registry.stop(decodeParam(m[1]!));
      return end(res, 204);
    }

    m = /^\/api\/streams\/([^/]+)\/manual-clip$/.exec(path);
    if (m && method === 'POST') {
      const r = await deps.registry.manualClip(decodeParam(m[1]!));
      return r.ok ? json(res, 201, publicClip(r.value)) : fail(res, 400, r.error);
    }

    if (method === 'PUT' && path === '/api/mode') {
      const body = await readJson(req);
      if (typeof body.multiStream !== 'boolean') return fail(res, 400, BAD_REQUEST);
      const r = deps.registry.setMultiStream(body.multiStream);
      return r.ok ? json(res, 200, deps.registry.mode()) : fail(res, 409, r.error);
    }

    if (method === 'GET' && path === '/api/clips') {
      const status = url.searchParams.get('status');
      const limit = url.searchParams.get('limit');
      if (status !== null && !ALL_STATUSES.includes(status as ClipStatus)) return fail(res, 400, BAD_REQUEST);
      if (limit !== null && !/^\d{1,4}$/.test(limit)) return fail(res, 400, BAD_REQUEST);
      const list = deps.clips.list({
        ...(url.searchParams.get('streamer') ? { streamer: url.searchParams.get('streamer')! } : {}),
        ...(status ? { status: status as ClipStatus } : {}),
        ...(limit ? { limit: Math.max(1, Number(limit)) } : {}),
      });
      return json(res, 200, list.map(publicClip));
    }

    m = /^\/api\/clips\/([^/]+)\/status$/.exec(path);
    if (m && method === 'POST') {
      const body = await readJson(req);
      if (!CHANGEABLE.includes(body.status as ClipStatus)) return fail(res, 400, BAD_REQUEST);
      const id = decodeParam(m[1]!);
      const clip = deps.clips.get(id);
      if (!clip) return fail(res, 404, 'Клип не найден');
      if (clip.status === 'pending' || clip.status === 'error') {
        return fail(res, 409, clip.status === 'pending' ? 'Клип ещё нарезается' : 'Клип не удалось нарезать');
      }
      deps.clips.update(id, { status: body.status as ClipStatus, statusChangedAt: new Date().toISOString() });
      const updated = deps.clips.get(id)!;
      broadcast('clip', publicClip(updated));
      return json(res, 200, publicClip(updated));
    }

    return fail(res, 404, 'Не найдено');
  }

  async function handleMedia(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!sessions.valid(cookieToken(req))) return fail(res, 401, 'Требуется вход');
    const m = /^\/media\/clips\/([A-Za-z0-9_-]+)\.mp4$/.exec(url.pathname);
    const clip = m ? deps.clips.get(m[1]!) : null;
    if (!clip || clip.fileDeleted || !clip.mp4Path) return end(res, 404);
    const headers: Record<string, string> = {};
    if (url.searchParams.get('download')) {
      headers['Content-Disposition'] = `attachment; filename="${basename(clip.mp4Path).replace(/["\\\r\n]/g, '_')}"`;
    }
    return sendFile(req, res, clip.mp4Path, 'video/mp4', true, { headers });
  }

  async function handleStatic(req: IncomingMessage, res: ServerResponse, rawPath: string): Promise<void> {
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      return end(res, 400);
    }
    if (pathname.includes('\0')) return end(res, 404);
    pathname = pathname.replace(/\\/g, '/');
    const target = resolve(webRoot, `.${pathname}`);
    if (target !== webRoot && !target.startsWith(webRoot + sep)) return end(res, 403);
    const ext = extname(target).toLowerCase();
    const isFile = target !== webRoot && (await stat(target).then((s) => s.isFile(), () => false));
    if (isFile) return sendFile(req, res, target, MIME[ext] ?? 'application/octet-stream', false, { csp: CSP });
    if (ext) return end(res, 404);
    return sendFile(req, res, join(webRoot, 'index.html'), MIME['.html']!, false, { csp: CSP }); // SPA fallback
  }

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const mutating = method !== 'GET' && method !== 'HEAD';
      if (mutating && req.headers.origin !== undefined) {
        if (!sameOrigin(req.headers.origin, req.headers.host)) return fail(res, 403, 'Запрос с чужого origin отклонён');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
        return fail(res, 413, 'Слишком большой запрос', { Connection: 'close' });
      }
      if (req.headers['transfer-encoding'] !== undefined && !readsBody(method, url.pathname)) {
        // Nobody reads this body: count it without buffering and cut the connection past the limit.
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY) return;
          if (res.headersSent) return void req.destroy();
          fail(res, 413, 'Слишком большой запрос', { Connection: 'close' });
          res.once('finish', () => req.destroy());
        });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/media/')) {
        if (method !== 'GET' && method !== 'HEAD') return end(res, 405, { Allow: 'GET, HEAD' });
        return await handleMedia(req, res, url);
      }
      if (method !== 'GET' && method !== 'HEAD') return end(res, 405, { Allow: 'GET, HEAD' });
      return await handleStatic(req, res, (req.url ?? '/').split(/[?#]/)[0]!);
    })().catch((err) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) return fail(res, err.status, err.message, err.status === 413 ? { Connection: 'close' } : {});
      fail(res, 500, 'Внутренняя ошибка сервера');
    });
  });

  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, host, () => ok());
  });

  return {
    port: (server.address() as AddressInfo).port,
    broadcast,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(pinger);
        deps.registry.off('streams', onStreams);
        deps.registry.off('clip', onClip);
        deps.registry.off('notice', onNotice);
        for (const res of sse.keys()) res.end();
        sse.clear();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
