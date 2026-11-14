import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { eventChannel } from '@shared/ipc';
import { createApp, type App } from './app';
import { attachHotkeys } from './hotkeys';
import { registerIpc } from './ipc';
import { startLocalServer, type LocalServer } from './server';

let mainWindow: BrowserWindow | null = null;
let core: App | null = null;
let server: LocalServer | null = null;
let quitting = false;

// The Twitch player should start with sound without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath('userData');
  server = await startLocalServer({ rendererDir: join(__dirname, '../renderer'), draftsDir: join(userDataDir, 'drafts') });
  const appOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : server.origin;

  core = createApp({
    dbFile: join(userDataDir, 'thr.sqlite'),
    userDataDir,
    videosDir: app.getPath('videos'),
    mediaOrigin: () => server!.origin,
    showItemInFolder: (p) => shell.showItemInFolder(p),
    send: (event, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel(event), payload);
    },
  });
  await core.start();

  registerIpc(ipcMain, core.api, (event) => {
    const frame = event.senderFrame;
    return Boolean(mainWindow && frame && frame === mainWindow.webContents.mainFrame && new URL(frame.url).origin === appOrigin);
  });

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    title: 'Twitch Highlight Recorder',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.on('closed', () => (mainWindow = null));
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appOrigin) event.preventDefault(); // the top-level page never leaves the app
  });
  attachHotkeys(contents, () => core!.getUi(), (action, wallMs) => core!.handleHotkey(action, wallMs));
  await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL ?? server.origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void app.whenReady().then(bootstrap).catch((e) => {
    console.error(e);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    // Stop capture first: it turns unsaved markers into a draft while the buffer still exists.
    void Promise.resolve(core?.shutdown())
      .catch(() => undefined)
      .then(() => server?.close())
      .catch(() => undefined)
      .finally(() => app.exit(0));
  });
}
