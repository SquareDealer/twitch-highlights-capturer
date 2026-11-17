import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { Result } from '@shared/types';
import type { OAuthLike } from '../main/drive/driveClient';
import type { DriveSettingsStore } from './driveSettings';

type Tokens = Record<string, unknown>;

export const DRIVE_CALLBACK_PATH = '/api/drive/callback';
/** Full Drive access: the upload folder already exists and was not created by this app. */
const SCOPES = ['https://www.googleapis.com/auth/drive', 'openid', 'email'];
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 10;
const STALE = 'Ссылка входа устарела. Начните подключение заново';
const DENIED = 'Доступ к Google Drive не выдан';
const BAD_ORIGIN = 'Google принимает адрес возврата только вида http://localhost или https:// с доменом. Откройте интерфейс по такому адресу.';

export interface ServiceDriveAuthDeps {
  settings: DriveSettingsStore;
  /** Tokens in clear text, mode 0600: the same protection as the password in config.json. */
  tokenFile: string;
  createClient(opts: { clientId: string; clientSecret: string; redirectUri?: string }): OAuthLike;
  now?: () => number;
}

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

/** Why Google would refuse a redirect back to this origin, or null when it accepts it. */
export function redirectProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return BAD_ORIGIN;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return null;
  if (url.protocol === 'https:' && isIP(host) === 0 && host !== '') return null;
  return BAD_ORIGIN;
}

/**
 * Google sign-in for the web service: the browser is sent to Google and comes back to
 * `<origin>/api/drive/callback`. The callback is trusted by its one-time `state` alone
 * (the session cookie is SameSite=Strict and does not travel with the redirect).
 */
export class ServiceDriveAuth {
  private readonly pending = new Map<string, { codeVerifier: string; redirectUri: string; expiresAt: number }>();
  private cached: { client: OAuthLike; clientId: string; clientSecret: string } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ServiceDriveAuthDeps) {
    this.now = deps.now ?? Date.now;
  }

  async status(): Promise<{ connected: boolean; email?: string }> {
    const stored = await this.load();
    return stored ? { connected: true, ...(stored.email ? { email: stored.email } : {}) } : { connected: false };
  }

  /** origin: scheme://host[:port] the interface was opened at. */
  begin(origin: string): Result<{ url: string }> {
    const { clientId, clientSecret } = this.deps.settings.get();
    if (!clientId || !clientSecret) return { ok: false, error: 'Сначала сохраните Client ID и Client Secret' };
    const problem = redirectProblem(origin);
    if (problem) return { ok: false, error: problem };

    const redirectUri = `${new URL(origin).origin}${DRIVE_CALLBACK_PATH}`;
    const state = randomBytes(24).toString('hex');
    const codeVerifier = base64url(randomBytes(32));
    const t = this.now();
    for (const [key, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(key);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(state, { codeVerifier, redirectUri, expiresAt: t + STATE_TTL_MS });

    try {
      const url = this.deps.createClient({ clientId, clientSecret, redirectUri }).generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
        code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
      });
      return { ok: true, value: { url } };
    } catch (e) {
      this.pending.delete(state);
      return { ok: false, error: `Не удалось начать авторизацию: ${(e as Error).message}` };
    }
  }

  /** The redirect back from Google. A state is single-use, whatever happens next. */
  async finish(state: string | null, code: string | null, error: string | null): Promise<Result<null>> {
    const p = state ? this.pending.get(state) : undefined;
    if (state) this.pending.delete(state);
    if (!p || p.expiresAt <= this.now()) return { ok: false, error: STALE };
    if (error || !code) return { ok: false, error: DENIED };
    const { clientId, clientSecret } = this.deps.settings.get();
    if (!clientId || !clientSecret) return { ok: false, error: 'Сначала сохраните Client ID и Client Secret' };
    let tokens: Tokens;
    try {
      const client = this.deps.createClient({ clientId, clientSecret, redirectUri: p.redirectUri });
      ({ tokens } = await client.getToken({ code, codeVerifier: p.codeVerifier, redirect_uri: p.redirectUri }));
    } catch (e) {
      return { ok: false, error: `Google отклонил авторизацию: ${(e as Error).message}` };
    }
    try {
      await this.save({ tokens, email: emailFromIdToken(tokens.id_token) });
    } catch (e) {
      return { ok: false, error: `Не удалось сохранить токен: ${(e as Error).message}` };
    }
    this.cached = null;
    return { ok: true, value: null };
  }

  /** Revokes the grant at Google (best effort) and forgets the tokens. */
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
    await this.invalidate();
  }

  /** Forgets the stored tokens without contacting Google (revoked, expired, or the keys changed). */
  async invalidate(): Promise<void> {
    this.cached = null;
    await rm(this.deps.tokenFile, { force: true });
  }

  /** An authorized client, or null while Drive is not connected. Refreshed tokens are persisted. */
  async client(): Promise<OAuthLike | null> {
    const { clientId, clientSecret } = this.deps.settings.get();
    const stored = await this.load();
    if (!stored || !clientId || !clientSecret) return null;
    if (this.cached?.clientId === clientId && this.cached.clientSecret === clientSecret) return this.cached.client;
    const client = this.deps.createClient({ clientId, clientSecret });
    client.setCredentials(stored.tokens);
    client.on('tokens', (fresh) => {
      // Google omits the refresh token on refresh: merge, never overwrite.
      void this.load()
        .then((current) => this.save({ tokens: { ...(current?.tokens ?? stored.tokens), ...fresh }, email: current?.email ?? stored.email }))
        .catch(() => undefined);
    });
    this.cached = { client, clientId, clientSecret };
    return client;
  }

  private async load(): Promise<{ tokens: Tokens; email?: string } | null> {
    try {
      const parsed = JSON.parse(await readFile(this.deps.tokenFile, 'utf8')) as { tokens?: Tokens; email?: string } | null;
      return parsed && typeof parsed.tokens === 'object' && parsed.tokens
        ? { tokens: parsed.tokens, ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}) }
        : null;
    } catch {
      return null;
    }
  }

  private async save(data: { tokens: Tokens; email?: string | undefined }): Promise<void> {
    await writeFile(this.deps.tokenFile, JSON.stringify(data), { mode: 0o600 });
  }
}
