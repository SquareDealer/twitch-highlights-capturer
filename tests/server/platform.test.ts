import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFileCipher, defaultDataDir, defaultVideosDir } from '../../src/server/platform';
import { tmpDir } from '../helpers';

test('шифрование токенов: расшифровывается тем же ключом, в файле нет открытого текста', () => {
  const dir = tmpDir();
  const keyFile = join(dir, 'key.bin');
  const data = createFileCipher(keyFile).encrypt('{"refresh_token":"rt-SECRET"}');
  expect(data.toString('latin1')).not.toContain('rt-SECRET');
  expect(existsSync(keyFile)).toBe(true);
  // a fresh instance (next start) reads the same key
  expect(createFileCipher(keyFile).decrypt(data)).toBe('{"refresh_token":"rt-SECRET"}');
});

test('шифрование: другой ключ, испорченные данные или старый формат не расшифровываются', () => {
  const dir = tmpDir();
  const data = createFileCipher(join(dir, 'a.bin')).encrypt('secret');
  expect(() => createFileCipher(join(dir, 'b.bin')).decrypt(data)).toThrow();
  const broken = Buffer.from(data);
  broken[broken.length - 1]! ^= 1;
  expect(() => createFileCipher(join(dir, 'a.bin')).decrypt(broken)).toThrow();
  expect(() => createFileCipher(join(dir, 'a.bin')).decrypt(Buffer.from('v10 electron safeStorage blob'))).toThrow();
});

test('повреждённый файл ключа → ошибка, а не тихая подмена', () => {
  const keyFile = join(tmpDir(), 'key.bin');
  writeFileSync(keyFile, 'short');
  expect(() => createFileCipher(keyFile).encrypt('x')).toThrow(/ключа/);
  expect(readFileSync(keyFile, 'utf8')).toBe('short');
});

test('папка данных: THR_DATA_DIR, иначе та же, что у Electron-версии', () => {
  expect(defaultDataDir({ THR_DATA_DIR: 'D:\\thr' }, 'win32', 'C:\\Users\\me')).toBe('D:\\thr');
  expect(defaultDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'twitch-highlight-recorder'));
  expect(defaultDataDir({}, 'darwin', '/Users/me')).toBe(join('/Users/me', 'Library', 'Application Support', 'twitch-highlight-recorder'));
  expect(defaultDataDir({}, 'linux', '/home/me')).toBe(join('/home/me', '.config', 'twitch-highlight-recorder'));
  expect(defaultVideosDir('win32', 'C:\\Users\\me')).toBe(join('C:\\Users\\me', 'Videos'));
  expect(defaultVideosDir('darwin', '/Users/me')).toBe(join('/Users/me', 'Movies'));
});
