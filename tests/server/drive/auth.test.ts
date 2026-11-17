import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../../src/server/db';
import { DriveAuth, type OAuthLike } from '../../../src/server/drive/auth';
import { defaultSettings, SettingsStore } from '../../../src/server/settings';
import { tmpDir } from '../../helpers';

let settings: SettingsStore;
let tokenFile: string;
let opened: string[];
let onOpen: (url: URL) => Promise<void>;
let fake: FakeOAuth;
let created: Array<{ clientId: string; clientSecret: string; redirectUri?: string }>;

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

class FakeOAuth implements OAuthLike {
  credentials: Record<string, unknown> = {};
  listeners: Array<(t: Record<string, unknown>) => void> = [];
  revoked: string[] = [];
  exchanged: Array<{ code: string; codeVerifier?: string; redirect_uri?: string }> = [];
  generateAuthUrl(o: Record<string, unknown>) {
    return `https://accounts.example/auth?${new URLSearchParams(o as Record<string, string>).toString()}`;
  }
  async getToken(o: { code: string; codeVerifier?: string; redirect_uri?: string }) {
    this.exchanged.push(o);
    if (o.code === 'bad') throw new Error('invalid_grant');
    return { tokens: { access_token: 'at-SECRET', refresh_token: 'rt-SECRET', id_token: idToken('user@example.com') } };
  }
  setCredentials(c: Record<string, unknown>) {
    this.credentials = c;
  }
  on(_e: 'tokens', cb: (t: Record<string, unknown>) => void) {
    this.listeners.push(cb);
  }
  async revokeToken(t: string) {
    this.revoked.push(t);
  }
  request = async () => ({ data: {}, headers: {} });
}

function makeAuth() {
  return new DriveAuth({
    settings, tokenFile,
    encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
    decrypt: (b) => Buffer.from(b.toString().replace(/^enc:/, ''), 'hex').toString(),
    openExternal: async (url) => {
      opened.push(url);
      await onOpen(new URL(url));
    },
    createClient: (o) => {
      created.push(o);
      return fake;
    },
    timeoutMs: 400,
  });
}

/** Plays the browser: follows the consent redirect back to the loopback listener. */
const approve = (code = 'good', tamperState = false) => async (url: URL) => {
  const redirect = new URL(url.searchParams.get('redirect_uri')!);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', tamperState ? 'forged' : url.searchParams.get('state')!);
  void fetch(redirect).catch(() => undefined);
};

beforeEach(() => {
  settings = new SettingsStore(openDb(':memory:'), defaultSettings({ videos: '/v', userData: '/u' }));
  settings.set({ driveClientId: 'client-id', driveClientSecret: 'client-secret' });
  tokenFile = join(tmpDir(), 'drive-token.bin');
  opened = [];
  created = [];
  fake = new FakeOAuth();
  onOpen = approve();
});

test('без Client ID/Secret connect возвращает понятную ошибку и не открывает браузер', async () => {
  settings.set({ driveClientId: '' });
  expect(await makeAuth().connect()).toEqual({ ok: false, error: 'Укажите Client ID и Client Secret в настройках' });
  expect(opened).toEqual([]);
  expect(await makeAuth().status()).toEqual({ connected: false });
});

test('connect: loopback-редирект, PKCE и state; токены сохраняются зашифрованными', async () => {
  const auth = makeAuth();
  expect(await auth.connect()).toEqual({ ok: true, value: null });
  const url = new URL(opened[0]!);
  expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive.file');
  expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
  expect(fake.exchanged[0]).toMatchObject({ code: 'good', redirect_uri: url.searchParams.get('redirect_uri') });
  expect(fake.exchanged[0]!.codeVerifier!.length).toBeGreaterThanOrEqual(43);
  expect(created[0]).toMatchObject({ clientId: 'client-id', clientSecret: 'client-secret' });
  expect(await auth.status()).toEqual({ connected: true, email: 'user@example.com' });
  const raw = readFileSync(tokenFile, 'utf8');
  expect(raw.startsWith('enc:')).toBe(true);
  expect(raw).not.toContain('rt-SECRET');
});

test('подделанный state отклоняется, токены не сохраняются', async () => {
  onOpen = approve('good', true);
  const r = await makeAuth().connect();
  expect(r).toEqual({ ok: false, error: 'Авторизация не завершена: время ожидания истекло' });
  expect(fake.exchanged).toEqual([]);
  expect(existsSync(tokenFile)).toBe(false);
});

test('ошибка обмена кода и отказ пользователя → ok:false без утечки секретов в текст', async () => {
  onOpen = approve('bad');
  expect(await makeAuth().connect()).toEqual({ ok: false, error: 'Google отклонил авторизацию: invalid_grant' });
  onOpen = async (url) => {
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', url.searchParams.get('state')!);
    void fetch(redirect).catch(() => undefined);
  };
  expect(await makeAuth().connect()).toEqual({ ok: false, error: 'Доступ к Google Drive не выдан' });
});

test('браузер не вернулся за отведённое время → таймаут, слушатель закрыт', async () => {
  let redirect = '';
  onOpen = async (url) => void (redirect = url.searchParams.get('redirect_uri')!);
  expect(await makeAuth().connect()).toEqual({ ok: false, error: 'Авторизация не завершена: время ожидания истекло' });
  await expect(fetch(redirect)).rejects.toThrow();
});

test('client() после перезапуска восстанавливает токены и сохраняет обновлённые', async () => {
  await makeAuth().connect();
  fake = new FakeOAuth();
  const restarted = makeAuth();
  const client = await restarted.client();
  expect(client).toBe(fake);
  expect(fake.credentials).toMatchObject({ refresh_token: 'rt-SECRET' });
  fake.listeners[0]!({ access_token: 'at-NEW' }); // refresh without a new refresh_token
  // the refreshed token is written in the background
  await vi.waitFor(async () => {
    fake = new FakeOAuth();
    await makeAuth().client();
    expect(fake.credentials).toMatchObject({ access_token: 'at-NEW', refresh_token: 'rt-SECRET' });
  });
});

test('client() возвращает null, когда не подключено или файл токена повреждён', async () => {
  expect(await makeAuth().client()).toBeNull();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tokenFile, 'garbage');
  expect(await makeAuth().client()).toBeNull();
  expect(await makeAuth().status()).toEqual({ connected: false });
});

test('disconnect отзывает токен и удаляет файл', async () => {
  const auth = makeAuth();
  await auth.connect();
  await auth.disconnect();
  expect(fake.revoked).toEqual(['rt-SECRET']);
  expect(existsSync(tokenFile)).toBe(false);
  expect(await auth.status()).toEqual({ connected: false });
  await expect(auth.disconnect()).resolves.toBeUndefined();
});
