import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import type { EventHub } from './events';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The app page drives the local backend, so it may only load its own code and the official
 * Twitch player (script + frame).
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://player.twitch.tv",
  'frame-src https://player.twitch.tv',
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_BODY_BYTES = 1024 * 1024;

/** What the HTTP layer needs from the application. */
export interface WebApi {
  /** Calls `group.method(...args)`; throws `NotFoundError` for anything not in the API. */
  call(group: string, method: string, args: unknown[]): Promise<unknown>;
  /** A key press the page turned into an action. */
  hotkey(body: unknown): void;
}

export class NotFoundError extends Error {}

export interface WebServer {
  port: number;
  /** `http://localhost:<port>` — the Twitch Embed accepts `parent=localhost`. */
  origin: string;
  address: string;
  close(): Promise<void>;
}

export interface WebServerOptions {
  /** Built web UI (`out/web`); null when the UI is served by the Vite dev server. */
  webDir: string | null;
  draftsDir: string;
  /** 0 picks a free port (tests). */
  port?: number;
  api?: WebApi;
  events?: EventHub;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function end(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Length': '0', ...headers });
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

/** Parses a single-range `Range` header. Returns null when absent/unsupported, 'invalid' when unsatisfiable. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let last: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    last = size - 1;
  } else {
    start = Number(m[1]);
    last = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > last ? 'invalid' : { start, end: last };
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string, ranged: boolean): Promise<void> {
  const size = await fileSize(path);
  if (size === null) return end(res, 404);
  const base: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (type.startsWith('text/html')) base['Content-Security-Policy'] = APP_CSP;
  if (ranged) base['Accept-Ranges'] = 'bytes';
  const range = ranged ? parseRange(req.headers.range, size) : null;
  if (range === 'invalid') return end(res, 416, { 'Content-Range': `bytes */${size}` });
  const start = range ? range.start : 0;
  const last = range ? range.end : size - 1;
  res.writeHead(range ? 206 : 200, {
    ...base,
    'Content-Length': String(size === 0 ? 0 : last - start + 1),
    ...(range ? { 'Content-Range': `bytes ${start}-${last}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || size === 0) return void res.end();
  const stream = createReadStream(path, { start, end: last });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new SyntaxError('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

/**
 * Only the app's own page may call the API. Browsers always send `Origin` with a POST, and a JSON body
 * forces a CORS preflight that this server never answers, so other sites (and the Twitch frame) cannot
 * reach it. `Sec-Fetch-Site` rejects cross-site reads of the event stream as well.
 */
function isSameOrigin(req: IncomingMessage, requireOrigin: boolean): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return !requireOrigin;
  return origin === `http://${req.headers.host ?? ''}`;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, opts: WebServerOptions): Promise<void> {
  if (pathname === '/api/events') {
    if (req.method !== 'GET') return end(res, 405, { Allow: 'GET' });
    if (!isSameOrigin(req, false)) return end(res, 403);
    if (!opts.events) return end(res, 404);
    return opts.events.attach(req, res);
  }
  if (req.method !== 'POST') return end(res, 405, { Allow: 'POST' });
  if (!isSameOrigin(req, true)) return json(res, 403, { error: 'Forbidden' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'Ожидается application/json' });
  if (!opts.api) return end(res, 404);

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'Некорректный JSON' });
  }

  if (pathname === '/api/hotkey') {
    opts.api.hotkey(body);
    return end(res, 204);
  }
  const m = /^\/api\/rpc\/([A-Za-z]+)\/([A-Za-z]+)$/.exec(pathname);
  if (!m) return json(res, 404, { error: 'Not found' });
  if (body !== null && !Array.isArray(body)) return json(res, 400, { error: 'Аргументы передаются массивом' });
  try {
    const value = await opts.api.call(m[1]!, m[2]!, (body as unknown[] | null) ?? []);
    return json(res, 200, value === undefined ? {} : { value });
  } catch (e) {
    if (e instanceof NotFoundError) return json(res, 404, { error: e.message });
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The app's only server: the built web UI, draft videos and the API, on 127.0.0.1.
 * The page must be opened as http://localhost so the official Twitch Embed gets a valid `parent`.
 */
export async function startWebServer(opts: WebServerOptions): Promise<WebServer> {
  const webRoot = opts.webDir ? resolve(opts.webDir) : null;
  const draftsRoot = resolve(opts.draftsDir);

  const server = createServer((req, res) => {
    void (async () => {
      // Requests must be addressed to this machine by name (blocks DNS-rebinding from web pages).
      const hostHeader = req.headers.host ?? '';
      const host = hostHeader.replace(/:\d+$/, '');
      if (host !== 'localhost' && host !== '127.0.0.1') return end(res, 403);
      let pathname: string;
      try {
        pathname = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]!);
      } catch {
        return end(res, 400);
      }
      if (pathname.includes('\0')) return end(res, 404);
      pathname = pathname.replace(/\\/g, '/');

      if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, pathname, opts);
      if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, { Allow: 'GET, HEAD' });

      if (pathname.startsWith('/media/')) {
        const m = /^\/media\/drafts\/([A-Za-z0-9_-]+)\.mp4$/.exec(pathname);
        if (!m) return end(res, 404);
        return sendFile(req, res, join(draftsRoot, `${m[1]}.mp4`), 'video/mp4', true);
      }

      if (!webRoot) return end(res, 404);
      const target = resolve(webRoot, `.${pathname}`);
      if (target !== webRoot && !target.startsWith(webRoot + sep)) return end(res, 403);
      const ext = extname(target).toLowerCase();
      if (target !== webRoot && (await fileSize(target)) !== null) {
        return sendFile(req, res, target, MIME[ext] ?? 'application/octet-stream', false);
      }
      if (ext) return end(res, 404);
      // The Twitch player refuses `parent=127.0.0.1`, so the page itself is always opened via localhost.
      if (host === '127.0.0.1') return end(res, 302, { Location: `http://localhost${hostHeader.slice(host.length)}${req.url ?? '/'}` });
      return sendFile(req, res, join(webRoot, 'index.html'), MIME['.html']!, false); // SPA fallback
    })().catch(() => {
      if (!res.headersSent) end(res, 500);
      else res.destroy();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolveListen());
  });
  const { port, address } = server.address() as AddressInfo;
  return {
    port,
    address,
    origin: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((done) => {
        opts.events?.close();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
