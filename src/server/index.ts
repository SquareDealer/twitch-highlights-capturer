import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { createApp, type App } from './app';
import { createDriveSync } from './drive';
import { DriveAuth, type OAuthLike } from './drive/auth';
import { createDriveClient } from './drive/driveClient';
import { EventHub } from './events';
import { startWebServer, type WebApi, type WebServer } from './http';
import { createFileCipher, defaultDataDir, defaultVideosDir, openExternal, showItemInFolder } from './platform';
import { createWebApi } from './rpc';

const DEFAULT_PORT = 3717;

const dev = process.env.THR_DEV === '1';
const port = Number(process.env.THR_PORT ?? DEFAULT_PORT);
const openBrowser = !dev && process.env.THR_NO_OPEN !== '1';

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`THR_PORT должен быть номером порта, получено: ${process.env.THR_PORT}`);
  const dataDir = defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const webDir = dev ? null : resolve(import.meta.dirname, '../../out/web');
  if (webDir && !existsSync(join(webDir, 'index.html'))) fail('Интерфейс не собран. Выполните: npm run build (или просто npm start).');

  const events = new EventHub();
  let core: App | null = null;
  let webApi: WebApi | null = null;
  let server: WebServer;
  try {
    // The server comes up first: a busy port means the app is already running, and nothing else is touched.
    server = await startWebServer({
      webDir,
      draftsDir: join(dataDir, 'drafts'),
      port,
      events,
      api: {
        call: (group, method, args) => (webApi ? webApi.call(group, method, args) : Promise.reject(new Error('Приложение ещё запускается'))),
        hotkey: (body) => webApi?.hotkey(body),
      },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const url = `http://localhost:${port}`;
      console.log(`\n  Порт ${port} уже занят — скорее всего приложение уже запущено: ${url}\n  Другой порт: THR_PORT=3800 npm start\n`);
      if (openBrowser) await openExternal(url).catch(() => undefined);
      process.exit(0);
    }
    throw e;
  }

  const cipher = createFileCipher(join(dataDir, 'drive-key.bin'));
  core = createApp({
    dbFile: join(dataDir, 'thr.sqlite'),
    userDataDir: dataDir,
    videosDir: defaultVideosDir(),
    mediaOrigin: () => '', // draft videos are served by the same origin as the page
    showItemInFolder: (p) => void showItemInFolder(p).catch((err: Error) => events.send('notice', { level: 'error', message: `Не удалось открыть папку: ${err.message}` })),
    send: (event, payload) => events.send(event, payload),
    createDrive: (ctx) => {
      const auth = new DriveAuth({
        settings: ctx.settings,
        tokenFile: join(ctx.userDataDir, 'drive-token.bin'),
        encrypt: cipher.encrypt,
        decrypt: cipher.decrypt,
        openExternal: async (url) => {
          console.log(`\n  Вход в Google: если браузер не открылся, перейдите по ссылке\n  ${url}\n`);
          await openExternal(url).catch(() => undefined);
        },
        createClient: (o) => new OAuth2Client(o) as unknown as OAuthLike,
      });
      return createDriveSync({
        repos: ctx.repos,
        settings: ctx.settings,
        auth,
        getClient: async () => {
          const client = await auth.client();
          return client ? createDriveClient((o) => client.request(o)) : null;
        },
        notify: ctx.notify,
        clipsChanged: ctx.clipsChanged,
      });
    },
  });
  await core.start();
  webApi = createWebApi(core);

  const pageUrl = dev ? 'http://localhost:5173' : server.origin;
  console.log(`\n  Twitch Highlight Recorder запущен: ${pageUrl}`);
  console.log(`  Данные: ${dataDir}`);
  console.log('  Остановить: Ctrl+C\n');
  if (openBrowser) await openExternal(pageUrl).catch(() => undefined);

  let quitting = false;
  const quit = () => {
    if (quitting) process.exit(1); // second Ctrl+C: do not wait
    quitting = true;
    console.log('\n  Останавливаю запись и сохраняю черновики…');
    // Stop capture first: it turns unsaved markers into a draft while the buffer still exists.
    void Promise.resolve(core?.shutdown())
      .catch(() => undefined)
      .then(() => server.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit); // the terminal window was closed
  if (process.platform === 'win32') process.on('SIGBREAK', quit);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
