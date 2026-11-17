import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { folderIdFromLink, httpStatus, type DriveClient, type DriveFolderLookup } from '../main/drive/driveClient';
import { end, MIME, sendFile } from '../main/server';
import { Sessions } from './auth';
import type { createClipRepo } from './clipRepo';
import type { ServiceConfig } from './config';
import { DRIVE_CALLBACK_PATH, redirectProblem, type ServiceDriveAuth } from './driveAuth';
import type { DriveFolder, DriveSettingsStore } from './driveSettings';
import { NOT_CONNECTED, type DriveSync, type DriveSyncState } from './driveSync';
import { factorySettings } from './profileSettings';
import type { Profile, ProfileService } from './profiles';
import type { StreamRegistry } from './streams';
import type { ClipStatus, FeedClip } from './types';

export interface DriveDeps {
  settings: DriveSettingsStore;
  auth: ServiceDriveAuth;
  sync: DriveSync;
  /** null while Google Drive is not connected. */
  client(): Promise<(DriveClient & DriveFolderLookup) | null>;
}

/** What the «Диск» tab shows. Never carries the client secret or a token. */
export interface DriveStatus {
  hasCredentials: boolean;
  clientId: string;
  connected: boolean;
  email: string | null;
  folder: DriveFolder | null;
  /** The address to register in the Google console, built from the address this request came to. */
  redirectUri: string;
  /** Why Google would refuse that address, or null. */
  redirectProblem: string | null;
  sync: DriveSyncState;
}

export interface HttpDeps {
  drive: DriveDeps;
  registry: StreamRegistry;
  profiles: ProfileService;
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
const DRIVE_AUTH_LOST = 'Доступ к Google Drive отозван. Подключите аккаунт заново';
const MAX_KEY_LENGTH = 300;
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

/** What the browser gets: no local paths, and of the Drive state only what the card shows. */
export const publicClip = ({ mp4Path: _m, jsonPath: _j, drive, ...rest }: FeedClip) => ({
  ...rest,
  drive: drive
    ? { status: drive.status, error: drive.error, url: drive.status === 'synced' && drive.fileId ? `https://drive.google.com/file/d/${encodeURIComponent(drive.fileId)}/view` : null }
    : null,
});

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length), 'Cache-Control': 'no-store' });
  res.end(data);
}
const fail = (res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}, path?: string) => {
  const data = Buffer.from(JSON.stringify(path === undefined ? { error } : { error, path }));
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
  (method === 'POST' && /^\/api\/(login|probe|streams|profiles)$/.test(path)) ||
  (method === 'PUT' && (path === '/api/mode' || path === '/api/drive/credentials' || path === '/api/drive/folder' || /^\/api\/profiles\/[^/]+$/.test(path) || /^\/api\/streams\/[^/]+\/profile$/.test(path))) ||
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
    for (const res of sse.keys()) {
      try {
        res.write(frame);
      } catch {
        sse.delete(res); // a dead response must never throw back into the emitter
      }
    }
  };

  const onStreams = (v: unknown) => broadcast('streams', v);
  const onClip = (c: FeedClip) => broadcast('clip', publicClip(c));
  const onNotice = (v: unknown) => broadcast('notice', v);
  deps.registry.on('streams', onStreams);
  deps.registry.on('clip', onClip);
  const onTuning = (v: unknown) => broadcast('tuning', v);
  const onProfiles = (v: Profile[]) => broadcast('profiles', v);
  deps.registry.on('notice', onNotice);
  deps.registry.on('tuning', onTuning);
  deps.profiles.on('list', onProfiles);

  /** scheme://host the request came to: what the browser has in its address bar. */
  const requestOrigin = (req: IncomingMessage): string => {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https' ? 'https' : 'http';
    return `${proto}://${req.headers.host ?? 'localhost'}`;
  };
  const driveState = async (): Promise<Omit<DriveStatus, 'redirectUri' | 'redirectProblem'>> => {
    const { clientId, clientSecret, folder } = deps.drive.settings.get();
    const account = await deps.drive.auth.status();
    return {
      hasCredentials: clientId !== '' && clientSecret !== '', clientId, connected: account.connected,
      email: account.email ?? null, folder, sync: deps.drive.sync.state(),
    };
  };
  const driveStatus = async (req: IncomingMessage): Promise<DriveStatus> => {
    const origin = requestOrigin(req);
    return { ...(await driveState()), redirectUri: `${origin}${DRIVE_CALLBACK_PATH}`, redirectProblem: redirectProblem(origin) };
  };
  const pushDrive = (): void => {
    void driveState().then((st) => broadcast('drive', st), () => undefined);
  };
  deps.drive.sync.on('state', pushDrive);
  deps.drive.sync.on('clip', onClip);
  /** A Drive call made for a route: a revoked grant signs out and becomes a 409, other failures a 502. */
  const driveCall = async <T,>(res: ServerResponse, fn: () => Promise<T>): Promise<{ value: T } | null> => {
    try {
      return { value: await fn() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (httpStatus(e) === 401 || /invalid_grant/i.test(message)) {
        await deps.drive.auth.invalidate();
        pushDrive();
        fail(res, 409, DRIVE_AUTH_LOST);
      } else {
        fail(res, 502, `Google Drive не ответил: ${message}`);
      }
      return null;
    }
  };
  const htmlPage = (res: ServerResponse, status: number, text: string): void => {
    const safe = text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const body = Buffer.from(
      `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Google Drive</title>` +
        `<body style="font:16px system-ui,sans-serif;background:#0e0f13;color:#e7e8ec;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">` +
        `<div><p>${safe}</p><p><a href="/#drive" style="color:#8b7cf6">Вернуться</a></p></div></body></html>`,
    );
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
    res.end(body);
  };
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

    // Google redirects here from another site, so the SameSite=Strict session cookie does not come along:
    // the one-time state issued by /api/drive/connect is what this route trusts.
    if (method === 'GET' && path === DRIVE_CALLBACK_PATH) {
      const q = url.searchParams;
      const r = await deps.drive.auth.finish(q.get('state'), q.get('code'), q.get('error'));
      pushDrive();
      if (!r.ok) return htmlPage(res, 400, r.error);
      return end(res, 302, { Location: '/#drive', 'Cache-Control': 'no-store' });
    }

    const token = cookieToken(req);
    if (!sessions.valid(token)) return fail(res, 401, 'Требуется вход');

    if (method === 'POST' && path === '/api/logout') {
      sessions.logout(token!);
      for (const [stream, t] of sse) if (t === token) closeStream(stream);
      return end(res, 204, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (method === 'GET' && path === '/api/state') {
      return json(res, 200, { streams: deps.registry.list(), mode: deps.registry.mode(), cutting: deps.cuttingPaused(), profiles: deps.profiles.list(), factorySettings: factorySettings() });
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
      if (body.profileId !== undefined && typeof body.profileId !== 'string') return fail(res, 400, BAD_REQUEST);
      const r = await deps.registry.start(body.url, body.quality, ...(body.profileId === undefined ? [] : [body.profileId]));
      return r.ok ? json(res, 201, r.value) : fail(res, isConflict(r.error) ? 409 : 400, r.error);
    }

    let m = /^\/api\/streams\/([^/]+)$/.exec(path);
    if (m && method === 'DELETE') {
      await deps.registry.stop(decodeParam(m[1]!));
      return end(res, 204);
    }

    m = /^\/api\/streams\/([^/]+)\/profile$/.exec(path);
    if (m && method === 'PUT') {
      const body = await readJson(req);
      if (typeof body.profileId !== 'string') return fail(res, 400, BAD_REQUEST);
      const r = deps.registry.setProfile(decodeParam(m[1]!), body.profileId);
      return r.ok ? json(res, 200, r.value) : fail(res, r.error === 'Эфир не найден' ? 404 : 400, r.error);
    }

    m = /^\/api\/streams\/([^/]+)\/tuning$/.exec(path);
    if (m && method === 'GET') {
      const t = deps.registry.tuning(decodeParam(m[1]!));
      return t ? json(res, 200, t) : fail(res, 404, 'Эфир не найден');
    }

    m = /^\/api\/streams\/([^/]+)\/manual-clip$/.exec(path);
    if (m && method === 'POST') {
      const r = await deps.registry.manualClip(decodeParam(m[1]!));
      return r.ok ? json(res, 201, publicClip(r.value)) : fail(res, 400, r.error);
    }

    if (method === 'GET' && path === '/api/profiles') return json(res, 200, deps.profiles.list());

    if (method === 'POST' && path === '/api/profiles') {
      const body = await readJson(req);
      const r = deps.profiles.create(body.name, body.copyFrom);
      return r.ok ? json(res, 201, r.value) : fail(res, r.status, r.error, {}, r.path);
    }

    m = /^\/api\/profiles\/([^/]+)$/.exec(path);
    if (m && method === 'PUT') {
      const body = await readJson(req);
      const r = deps.profiles.update(decodeParam(m[1]!), { name: body.name, settings: body.settings });
      return r.ok ? json(res, 200, r.value) : fail(res, r.status, r.error, {}, r.path);
    }
    if (m && method === 'DELETE') {
      const id = decodeParam(m[1]!);
      if (deps.registry.profileInUse(id)) return fail(res, 409, 'Профиль используется идущим эфиром');
      const r = deps.profiles.remove(id);
      return r.ok ? end(res, 204) : fail(res, r.status, r.error, {}, r.path);
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
      // 'new'/'taken' promise a playable file; the janitor already deleted this one.
      if (clip.fileDeleted && body.status !== 'rejected') return fail(res, 409, 'Файл клипа удалён');
      deps.clips.update(id, { status: body.status as ClipStatus, statusChangedAt: new Date().toISOString() });
      const updated = deps.clips.get(id)!;
      broadcast('clip', publicClip(updated));
      return json(res, 200, publicClip(updated));
    }

    if (method === 'GET' && path === '/api/drive') return json(res, 200, await driveStatus(req));

    if (method === 'PUT' && path === '/api/drive/credentials') {
      const body = await readJson(req);
      const stored = deps.drive.settings.get();
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
      let clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : null;
      // The secret is never sent to the browser, so an empty one means "leave it" — for the same client only.
      if (clientSecret === '' && clientId === stored.clientId) clientSecret = stored.clientSecret;
      if (!clientId || !clientSecret || clientId.length > MAX_KEY_LENGTH || clientSecret.length > MAX_KEY_LENGTH) {
        return fail(res, 400, 'Укажите Client ID и Client Secret');
      }
      if (clientId !== stored.clientId || clientSecret !== stored.clientSecret) {
        deps.drive.settings.setCredentials(clientId, clientSecret);
        await deps.drive.auth.invalidate(); // a token belongs to the client it was issued to
      }
      pushDrive();
      return json(res, 200, await driveStatus(req));
    }

    if (method === 'POST' && path === '/api/drive/connect') {
      const r = deps.drive.auth.begin(requestOrigin(req));
      return r.ok ? json(res, 200, r.value) : fail(res, 400, r.error);
    }

    if (method === 'POST' && path === '/api/drive/disconnect') {
      await deps.drive.auth.disconnect();
      pushDrive();
      return end(res, 204);
    }

    if (method === 'GET' && path === '/api/drive/folders') {
      const name = (url.searchParams.get('name') ?? '').trim();
      if (name === '' || name.length > 200) return fail(res, 400, 'Укажите имя папки');
      const client = await deps.drive.client();
      if (!client) return fail(res, 409, NOT_CONNECTED);
      const found = await driveCall(res, () => client.findFolders(name));
      return found ? json(res, 200, found.value) : undefined;
    }

    if (method === 'PUT' && path === '/api/drive/folder') {
      const body = await readJson(req);
      const given = typeof body.id === 'string' ? body.id : typeof body.link === 'string' ? body.link : '';
      const id = folderIdFromLink(given);
      if (!id) return fail(res, 400, 'Это не ссылка на папку Google Drive');
      const client = await deps.drive.client();
      if (!client) return fail(res, 409, NOT_CONNECTED);
      const found = await driveCall(res, () => client.getFolder(id));
      if (!found) return;
      if (!found.value) return fail(res, 404, 'Папка не найдена или к ней нет доступа');
      if (!found.value.canAddChildren) return fail(res, 409, 'В эту папку нельзя добавлять файлы');
      deps.drive.settings.setFolder({ id: found.value.id, name: found.value.name, path: found.value.path });
      pushDrive();
      return json(res, 200, await driveStatus(req));
    }

    if (method === 'POST' && path === '/api/drive/sync') {
      if (!(await deps.drive.auth.status()).connected) return fail(res, 409, NOT_CONNECTED);
      const r = deps.drive.sync.start();
      return r.ok ? json(res, 202, r.value) : fail(res, 409, r.error);
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
        deps.registry.off('tuning', onTuning);
        deps.profiles.off('list', onProfiles);
        deps.drive.sync.off('state', pushDrive);
        deps.drive.sync.off('clip', onClip);
        for (const res of sse.keys()) res.end();
        sse.clear();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
