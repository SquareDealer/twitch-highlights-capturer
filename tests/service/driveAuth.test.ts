import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/main/db';
import type { OAuthLike } from '../../src/main/drive/auth';
import { DRIVE_CALLBACK_PATH, redirectProblem, ServiceDriveAuth } from '../../src/service/driveAuth';
import { createDriveSettings } from '../../src/service/driveSettings';
import { tmpDir } from '../helpers';

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

class FakeOAuth implements OAuthLike {
  credentials: Record<string, unknown> = {};
  listeners: Array<(t: Record<string, unknown>) => void> = [];
  revoked: string[] = [];
  exchanged: Array<{ code: string; codeVerifier?: string; redirect_uri?: string }> = [];
  revokeFails = false;
  generateAuthUrl(o: Record<string, unknown>) {
    return `https://accounts.example/auth?${new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString()}`;
  }
  async getToken(o: { code: string; codeVerifier?: string; redirect_uri?: string }) {
    this.exchanged.push(o);
    if (o.code === 'bad') throw new Error('invalid_grant');
    return { tokens: { access_token: 'at-1', refresh_token: 'rt-1', id_token: idToken('user@example.com') } };
  }
  setCredentials(c: Record<string, unknown>) { this.credentials = c; }
  on(_e: 'tokens', cb: (t: Record<string, unknown>) => void) { this.listeners.push(cb); }
  async revokeToken(t: string) {
    if (this.revokeFails) throw new Error('offline');
    this.revoked.push(t);
  }
  request = async () => ({ data: {}, headers: {} });
}

let dir: string;
let tokenFile: string;
let settings: ReturnType<typeof createDriveSettings>;
let fake: FakeOAuth;
let created: Array<{ clientId: string; clientSecret: string; redirectUri?: string }>;
let now: number;
const make = () => new ServiceDriveAuth({ settings, tokenFile, now: () => now, createClient: (o) => { created.push(o); return fake; } });
const ORIGIN = 'http://localhost:8080';
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const begin = (a: ServiceDriveAuth, origin = ORIGIN) => {
  const r = a.begin(origin);
  if (!r.ok) throw new Error(r.error);
  return r.value.url;
};

beforeEach(() => {
  dir = tmpDir();
  tokenFile = join(dir, 'drive-token.json');
  settings = createDriveSettings(openDb(':memory:'));
  settings.setCredentials('cid', 'csecret');
  fake = new FakeOAuth();
  created = [];
  now = 1_000_000;
});

describe('redirectProblem', () => {
  it.each(['http://localhost:8080', 'http://127.0.0.1:9000', 'http://localhost', 'https://clips.example.com', 'https://clips.example.com:8443'])('accepts %s', (o) => expect(redirectProblem(o)).toBeNull());
  it.each(['http://192.168.1.5:8080', 'http://clips.example.com', 'https://10.0.0.2', 'https://[::1]:8080', 'ftp://x', 'nonsense', ''])('refuses %s', (o) =>
    expect(redirectProblem(o)).toBe('Google принимает адрес возврата только вида http://localhost или https:// с доменом. Откройте интерфейс по такому адресу.'));
});

it('refuses to begin without keys or from an origin Google will not redirect to', () => {
  expect(make().begin('http://192.168.1.5:8080')).toMatchObject({ ok: false, error: expect.stringContaining('Google принимает адрес возврата') });
  settings.setCredentials('', '');
  expect(make().begin(ORIGIN)).toEqual({ ok: false, error: 'Сначала сохраните Client ID и Client Secret' });
});

it('builds the consent link with the full Drive scope, PKCE and the callback of this origin', () => {
  const url = new URL(begin(make()));
  const q = url.searchParams;
  expect(q.get('redirect_uri')).toBe(`${ORIGIN}${DRIVE_CALLBACK_PATH}`);
  expect(q.get('scope')).toBe('https://www.googleapis.com/auth/drive,openid,email');
  expect([q.get('access_type'), q.get('prompt'), q.get('code_challenge_method')]).toEqual(['offline', 'consent', 'S256']);
  expect(q.get('state')!.length).toBeGreaterThanOrEqual(32);
  expect(q.get('code_challenge')).toBeTruthy();
  expect(created[0]).toEqual({ clientId: 'cid', clientSecret: 'csecret', redirectUri: `${ORIGIN}${DRIVE_CALLBACK_PATH}` });
});

it('finishes sign-in: exchanges the code with the verifier, stores the token, reports the e-mail', async () => {
  const a = make();
  expect(await a.status()).toEqual({ connected: false });
  const state = stateOf(begin(a));
  expect(await a.finish(state, 'good', null)).toEqual({ ok: true, value: null });
  expect(fake.exchanged[0]).toMatchObject({ code: 'good', redirect_uri: `${ORIGIN}${DRIVE_CALLBACK_PATH}` });
  expect(fake.exchanged[0]!.codeVerifier).toBeTruthy();
  expect(await a.status()).toEqual({ connected: true, email: 'user@example.com' });
  expect(JSON.parse(readFileSync(tokenFile, 'utf8')).tokens.refresh_token).toBe('rt-1');
});

it('a state works once, even when the exchange failed', async () => {
  const a = make();
  const s1 = stateOf(begin(a));
  await a.finish(s1, 'good', null);
  expect(await a.finish(s1, 'good', null)).toEqual({ ok: false, error: 'Ссылка входа устарела. Начните подключение заново' });
  expect(fake.exchanged).toHaveLength(1);
  const s2 = stateOf(begin(a));
  expect(await a.finish(s2, 'bad', null)).toMatchObject({ ok: false, error: expect.stringContaining('Google отклонил авторизацию') });
  expect(await a.finish(s2, 'good', null)).toMatchObject({ ok: false, error: expect.stringContaining('устарела') });
});

it('refuses an unknown, missing or expired state and writes nothing', async () => {
  const a = make();
  for (const s of ['made-up', '', null]) expect(await a.finish(s, 'good', null)).toMatchObject({ ok: false, error: expect.stringContaining('устарела') });
  const state = stateOf(begin(a));
  now += 10 * 60_000 + 1;
  expect(await a.finish(state, 'good', null)).toMatchObject({ ok: false, error: expect.stringContaining('устарела') });
  expect(existsSync(tokenFile)).toBe(false);
  expect(fake.exchanged).toEqual([]);
});

it('reports a denied consent', async () => {
  const a = make();
  expect(await a.finish(stateOf(begin(a)), null, 'access_denied')).toEqual({ ok: false, error: 'Доступ к Google Drive не выдан' });
  expect(await a.finish(stateOf(begin(a)), null, null)).toEqual({ ok: false, error: 'Доступ к Google Drive не выдан' });
  expect(existsSync(tokenFile)).toBe(false);
});

it('keeps at most ten pending sign-ins, dropping the oldest', async () => {
  const a = make();
  const first = stateOf(begin(a));
  for (let i = 0; i < 10; i++) begin(a);
  expect(await a.finish(first, 'good', null)).toMatchObject({ ok: false });
});

it('survives a restart: the token is read back, a pending state is not', async () => {
  const a = make();
  const pending = stateOf(begin(a));
  await a.finish(stateOf(begin(a)), 'good', null);
  const b = make();
  expect(await b.status()).toEqual({ connected: true, email: 'user@example.com' });
  expect(await b.finish(pending, 'good', null)).toMatchObject({ ok: false });
  const client = await b.client();
  expect(client).toBe(fake);
  expect(fake.credentials).toMatchObject({ refresh_token: 'rt-1' });
});

it('merges refreshed tokens without losing the refresh token', async () => {
  const a = make();
  await a.finish(stateOf(begin(a)), 'good', null);
  await a.client();
  fake.listeners[0]!({ access_token: 'at-2' });
  await vi.waitFor(() => expect(JSON.parse(readFileSync(tokenFile, 'utf8')).tokens.access_token).toBe('at-2'));
  expect(JSON.parse(readFileSync(tokenFile, 'utf8')).tokens.refresh_token).toBe('rt-1');
});

it('gives no client while not connected or without keys', async () => {
  expect(await make().client()).toBeNull();
  const a = make();
  await a.finish(stateOf(begin(a)), 'good', null);
  settings.setCredentials('', '');
  expect(await a.client()).toBeNull();
});

it('disconnect revokes and forgets the token, even when revoking fails', async () => {
  const a = make();
  await a.finish(stateOf(begin(a)), 'good', null);
  fake.revokeFails = true;
  await a.disconnect();
  expect(existsSync(tokenFile)).toBe(false);
  expect(await a.status()).toEqual({ connected: false });
  await a.finish(stateOf(begin(a)), 'good', null);
  fake.revokeFails = false;
  await a.disconnect();
  expect(fake.revoked).toEqual(['rt-1']);
});

it('treats a damaged token file as not connected', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tokenFile, '{oops');
  expect(await make().status()).toEqual({ connected: false });
});
