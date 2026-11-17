import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const APP_DIR_NAME = 'twitch-highlight-recorder';

/**
 * Where the database, drafts and the buffer live. Same folder the Electron build used
 * (`%APPDATA%\twitch-highlight-recorder` on Windows), so existing drafts and clips are picked up.
 * `THR_DATA_DIR` overrides it.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.THR_DATA_DIR) return env.THR_DATA_DIR;
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_DIR_NAME);
}

/** The user's videos folder; the clip library defaults to `<videos>/TwitchHighlights`. */
export function defaultVideosDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return join(home, platform === 'darwin' ? 'Movies' : 'Videos');
}

function launch(command: string, args: string[], verbatim = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Opens an http(s) link in the default browser (Google sign-in, the app page itself). */
export function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error(`Отказано в открытии ссылки: ${url}`));
  if (process.platform === 'win32') return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

/** Shows a saved clip in the system file manager. */
export function showItemInFolder(path: string): Promise<void> {
  if (process.platform === 'win32') return launch('explorer.exe', [`/select,"${path}"`], true);
  if (process.platform === 'darwin') return launch('open', ['-R', path]);
  return launch('xdg-open', [dirname(path)]);
}

/**
 * Encrypts the Google tokens at rest with AES-256-GCM. The key is a random file next to the data
 * (readable by the same OS user only where the OS supports file modes); it keeps the tokens out of
 * backups and casual reads of the token file, but is not a substitute for a system keychain.
 */
export function createFileCipher(keyFile: string): { encrypt(plain: string): Buffer; decrypt(data: Buffer): string } {
  let key: Buffer | null = null;
  const getKey = () => {
    if (key) return key;
    if (existsSync(keyFile)) {
      key = readFileSync(keyFile);
      if (key.length !== 32) throw new Error('файл ключа повреждён');
    } else {
      mkdirSync(dirname(keyFile), { recursive: true });
      key = randomBytes(32);
      writeFileSync(keyFile, key, { mode: 0o600 });
    }
    return key;
  };
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from('THR1'), iv, cipher.getAuthTag(), body]);
    },
    decrypt(data) {
      if (data.subarray(0, 4).toString() !== 'THR1') throw new Error('неизвестный формат');
      const decipher = createDecipheriv('aes-256-gcm', getKey(), data.subarray(4, 16));
      decipher.setAuthTag(data.subarray(16, 32));
      return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
    },
  };
}
