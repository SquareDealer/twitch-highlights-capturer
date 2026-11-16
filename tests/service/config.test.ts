import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bufferDirProblem, defaultConfig, loadConfig, saveConfigPatch } from '../../src/service/config';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  file = path.join(dir, 'config.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (o: unknown) => fs.writeFileSync(file, JSON.stringify(o));

describe('service config', () => {
  it('ignores unknown detector keys', () => {
    write({ password: 'x', detector: { chat: { someOldKey: 3 }, oldSection: { C: 1 } } });
    const cfg = loadConfig(file, dir);
    expect(cfg.detector.chat.minTriggerShare).toBe(0.05);
    expect((cfg.detector.chat as unknown as Record<string, unknown>).someOldKey).toBeUndefined();
  });

  it('has the new score defaults', () => {
    expect(defaultConfig('D:/d').detector.score).toEqual({ shareFull: 0.3, spikeFull: 6, audioMinDb: 10, audioFullDb: 20 });
  });

  it('defaults match the spec', () => {
    const c = defaultConfig('D:/d');
    expect(c.detector.chat.massSpike).toBe(6);
    expect(c.port).toBe(8080);
    expect(c.libraryDir).toBe(path.join('D:/d', 'library'));
    expect(c.bufferDir).toBe(path.join('D:/d', 'buffer'));
    expect(c.diskReserveBytes).toBe(10 * 1024 ** 3);
    expect(c.detector.weights).toEqual({ C: 0.35, E: 0.25, U: 0.2, A: 0.2 });
    expect(c.detector.chat.laughWords).toContain('^lo+l$');
    expect(c.detector.chat.laughWords).toHaveLength(17);
    expect(c.detector.chat.reactionWords).toHaveLength(10);
    expect(c.detector.chat.interactiveWords).toHaveLength(7);
    expect(() => c.detector.chat.laughWords.forEach((w) => new RegExp(w, 'i'))).not.toThrow();
  });

  it('default laugh regexes do not backtrack and still match laughs', () => {
    const res = defaultConfig('D:/d').detector.chat.laughWords.map((w) => new RegExp(w, 'i'));
    for (const re of res) {
      const t = Date.now();
      re.test('ах'.repeat(30) + '!');
      expect(Date.now() - t).toBeLessThan(50);
    }
    for (const w of ['ахахах', 'хаха', 'хахахаха']) expect(res.some((re) => re.test(w))).toBe(true);
    expect(res.some((re) => re.test('ах'))).toBe(false);
  });

  it('merges file over defaults', () => {
    write({ password: 'x', preRollMs: 20000, detector: { chat: { massSpike: 7 } } });
    const c = loadConfig(file, 'D:/d');
    expect(c.preRollMs).toBe(20000);
    expect(c.postRollMs).toBe(10000);
    expect(c.detector.chat.massSpike).toBe(7);
    expect(c.detector.chat.laughSpike).toBe(3);
    expect(c.detector.audio.triggerDb).toBe(15);
  });

  it('derives library/buffer from overridden dataDir', () => {
    write({ password: 'x', dataDir: 'E:/z' });
    const c = loadConfig(file, 'D:/d');
    expect(c.libraryDir).toBe(path.join('E:/z', 'library'));
  });

  it('rejects empty password and wrong types with field name', () => {
    write({ password: '' });
    expect(() => loadConfig(file, 'D:/d')).toThrow(/password/);
    write({ password: 'x', port: '80' });
    expect(() => loadConfig(file, 'D:/d')).toThrow(/port/);
    write({ password: 'x', detector: { chat: { alpha: 'a' } } });
    expect(() => loadConfig(file, 'D:/d')).toThrow(/detector\.chat\.alpha/);
    write({ password: 'x', detector: { chat: { laughWords: [1] } } });
    expect(() => loadConfig(file, 'D:/d')).toThrow(/laughWords/);
  });

  it('saveConfigPatch changes only multiStream', () => {
    write({ password: 'x', port: 9000, extra: { a: 1 } });
    saveConfigPatch(file, { multiStream: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ password: 'x', port: 9000, extra: { a: 1 }, multiStream: true });
  });
});

describe('bufferDirProblem', () => {
  const base = path.resolve('/srv/hl/data');
  const cfg = (bufferDir: string, libraryDir = path.join(base, 'library')) => ({ ...defaultConfig(base), libraryDir, bufferDir });

  it('accepts the default layout and a separate directory', () => {
    expect(bufferDirProblem(defaultConfig(base))).toBeNull();
    expect(bufferDirProblem(cfg(path.resolve('/tmp/hl-buffer')))).toBeNull();
    expect(bufferDirProblem(cfg(path.join(base, 'library-buffer')))).toBeNull(); // a sibling sharing a prefix
  });

  it('refuses a directory that would wipe the data, the library or a whole disk', () => {
    const bad = [
      base, // equals dataDir
      path.join(base, 'library'), // equals libraryDir
      path.dirname(base), // parent of dataDir
      path.resolve('/srv'), // grandparent
      path.parse(base).root, // filesystem root
      path.join(base, 'library', '..'), // equals dataDir once resolved
    ];
    for (const b of bad) expect(bufferDirProblem(cfg(b)), b).toMatch(/^Папка буфера/);
    // the library outside dataDir is protected as well
    expect(bufferDirProblem(cfg(path.resolve('/media'), path.resolve('/media/clips')))).toMatch(/^Папка буфера/);
  });

  it.runIf(process.platform === 'win32')('compares paths case-insensitively on Windows', () => {
    expect(bufferDirProblem(cfg(base.toUpperCase()))).toMatch(/^Папка буфера/);
  });
});
