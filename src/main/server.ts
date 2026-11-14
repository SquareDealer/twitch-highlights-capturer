import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

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
 * The app page runs with access to the main process, so it may only load its own code and the official
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
].join('; ');

export interface LocalServer {
  port: number;
  /** `http://localhost:<port>` — the Twitch Embed accepts `parent=localhost`. */
  origin: string;
  address: string;
  close(): Promise<void>;
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

/**
 * Serves the renderer and draft videos on 127.0.0.1.
 * The app is loaded from http://localhost so the official Twitch Embed gets a valid `parent`.
 */
export async function startLocalServer(opts: { rendererDir: string; draftsDir: string }): Promise<LocalServer> {
  const rendererRoot = resolve(opts.rendererDir);
  const draftsRoot = resolve(opts.draftsDir);

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, { Allow: 'GET, HEAD' });
      // Requests must be addressed to this machine by name (blocks DNS-rebinding from web pages).
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== 'localhost' && host !== '127.0.0.1') return end(res, 403);
      let pathname: string;
      try {
        pathname = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]!);
      } catch {
        return end(res, 400);
      }
      if (pathname.includes('\0')) return end(res, 404);
      pathname = pathname.replace(/\\/g, '/');

      if (pathname.startsWith('/media/')) {
        const m = /^\/media\/drafts\/([A-Za-z0-9_-]+)\.mp4$/.exec(pathname);
        if (!m) return end(res, 404);
        return sendFile(req, res, join(draftsRoot, `${m[1]}.mp4`), 'video/mp4', true);
      }

      const target = resolve(rendererRoot, `.${pathname}`);
      if (target !== rendererRoot && !target.startsWith(rendererRoot + sep)) return end(res, 403);
      const ext = extname(target).toLowerCase();
      if (target !== rendererRoot && (await fileSize(target)) !== null) {
        return sendFile(req, res, target, MIME[ext] ?? 'application/octet-stream', false);
      }
      if (ext) return end(res, 404);
      return sendFile(req, res, join(rendererRoot, 'index.html'), MIME['.html']!, false); // SPA fallback
    })().catch(() => {
      if (!res.headersSent) end(res, 500);
      else res.destroy();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const { port, address } = server.address() as AddressInfo;
  return {
    port,
    address,
    origin: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
