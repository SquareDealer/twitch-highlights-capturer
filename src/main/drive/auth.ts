import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DriveStatus, Result } from '@shared/types';
import type { SettingsStore } from '../settings';
import type { DriveRequest } from './driveClient';

type Tokens = Record<string, unknown>;

/** The part of google-auth-library's OAuth2Client that is used here (lets tests substitute it). */
export interface OAuthLike {
  generateAuthUrl(opts: Record<string, unknown>): string;
  getToken(opts: { code: string; codeVerifier?: string; redirect_uri?: string }): Promise<{ tokens: Tokens }>;
  setCredentials(tokens: Tokens): void;
  on(event: 'tokens', cb: (tokens: Tokens) => void): unknown;
  revokeToken(token: string): Promise<unknown>;
  request: DriveRequest;
}

export interface DriveAuthDeps {
  settings: SettingsStore;
  tokenFile: string;
  /** Electron safeStorage in production: tokens never touch the disk in clear text. */
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
  openExternal(url: string): Promise<void>;
  createClient: (opts: { clientId: string; clientSecret: string; redirectUri?: string }) => OAuthLike;
  timeoutMs?: number;
}

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const CALLBACK_PATH = '/oauth2callback';
const base64url = (b: Buffer) => b.toString('base64url');

function emailFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown };
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

const page = (text: string) =>
  `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Twitch Highlight Recorder</title><body style="font:16px sans-serif;background:#0e0e10;color:#efeff1;display:grid;place-items:center;height:100vh;margin:0"><p>${text}</p></body></html>`;

/** Google sign-in for an installed app: system browser + loopback redirect + PKCE. */
export class DriveAuth {
  private cached: { client: OAuthLike; clientId: string } | null = null;

  constructor(private readonly deps: DriveAuthDeps) {}

  async status(): Promise<DriveStatus> {
    const stored = await this.load();
    return stored ? { connected: true, ...(stored.email ? { email: stored.email } : {}) } : { connected: false };
  }

  async isConnected(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  async connect(): Promise<Result<null>> {
    const { driveClientId: clientId, driveClientSecret: clientSecret } = this.deps.settings.get();
    if (!clientId || !clientSecret) return { ok: false, error: 'Укажите Client ID и Client Secret в настройках' };

    const state = randomBytes(24).toString('hex');
    const codeVerifier = base64url(randomBytes(32));
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

    type Answer = { code: string } | { denied: true } | { timeout: true };
    let settle!: (a: Answer) => void;
    const answer = new Promise<Answer>((resolve) => (settle = resolve));
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const html = (status: number, text: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(page(text));
      };
      if (url.pathname !== CALLBACK_PATH) return html(404, 'Страница не найдена.');
      // Only the redirect that carries our own state is trusted; anything else is ignored.
      if (url.searchParams.get('state') !== state) return html(400, 'Некорректный запрос авторизации.');
      const code = url.searchParams.get('code');
      if (url.searchParams.get('error') || !code) {
        html(200, 'Доступ не выдан. Это окно можно закрыть.');
        return settle({ denied: true });
      }
      html(200, 'Готово. Вернитесь в Twitch Highlight Recorder — это окно можно закрыть.');
      settle({ code });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;
    const timer = setTimeout(() => settle({ timeout: true }), this.deps.timeoutMs ?? 5 * 60_000);

    try {
      const client = this.deps.createClient({ clientId, clientSecret, redirectUri });
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
      });
      await this.deps.openExternal(authUrl);
      const result = await answer;
      if ('timeout' in result) return { ok: false, error: 'Авторизация не завершена: время ожидания истекло' };
      if ('denied' in result) return { ok: false, error: 'Доступ к Google Drive не выдан' };
      let tokens: Tokens;
      try {
        ({ tokens } = await client.getToken({ code: result.code, codeVerifier, redirect_uri: redirectUri }));
      } catch (e) {
        return { ok: false, error: `Google отклонил авторизацию: ${(e as Error).message}` };
      }
      await this.save({ tokens, email: emailFromIdToken(tokens.id_token) });
      this.cached = null;
      return { ok: true, value: null };
    } catch (e) {
      return { ok: false, error: `Не удалось начать авторизацию: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    }
  }

  async disconnect(): Promise<void> {
    const stored = await this.load();
    const refreshToken = stored?.tokens.refresh_token;
    if (stored && typeof refreshToken === 'string') {
      try {
        await (await this.client())?.revokeToken(refreshToken);
      } catch {
        /* offline or already revoked: forgetting the token locally is what matters */
      }
    }
    this.cached = null;
    await rm(this.deps.tokenFile, { force: true });
  }

  /** An authorized client, or null while Drive is not connected. Refreshed tokens are persisted. */
  async client(): Promise<OAuthLike | null> {
    const { driveClientId: clientId, driveClientSecret: clientSecret } = this.deps.settings.get();
    const stored = await this.load();
    if (!stored || !clientId || !clientSecret) return null;
    if (this.cached?.clientId === clientId) return this.cached.client;
    const client = this.deps.createClient({ clientId, clientSecret });
    client.setCredentials(stored.tokens);
    client.on('tokens', (fresh) => {
      // Google omits the refresh token on refresh: merge, never overwrite.
      void this.load()
        .then((current) => this.save({ tokens: { ...(current?.tokens ?? stored.tokens), ...fresh }, email: current?.email ?? stored.email }))
        .catch(() => undefined);
    });
    this.cached = { client, clientId };
    return client;
  }

  private async load(): Promise<{ tokens: Tokens; email?: string } | null> {
    try {
      const parsed = JSON.parse(this.deps.decrypt(await readFile(this.deps.tokenFile))) as { tokens?: Tokens; email?: string };
      return parsed && typeof parsed.tokens === 'object' && parsed.tokens ? { tokens: parsed.tokens, email: parsed.email } : null;
    } catch {
      return null;
    }
  }

  private async save(data: { tokens: Tokens; email?: string }): Promise<void> {
    await writeFile(this.deps.tokenFile, this.deps.encrypt(JSON.stringify(data)), { mode: 0o600 });
  }
}
