import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DetectorProcess, type DetectorProcessOptions } from '../../src/service/detectorProcess';
import { settingsFromConfig } from '../../src/service/profileSettings';
import { defaultConfig } from '../../src/service/config';

const D1 = settingsFromConfig(defaultConfig('/d')).detector;
const FAKE = resolve(__dirname, 'fixtures', 'fakeDetector.mjs');
const procs: DetectorProcess[] = [];

function make(extra: string[] = [], opts: Partial<DetectorProcessOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fakedet-'));
  const log = join(dir, 'frames.log');
  const dp = new DetectorProcess({
    command: process.execPath,
    args: [FAKE, '--log', log, ...extra],
    cwd: dir,
    restartDelaysMs: [30],
    ...opts,
  });
  procs.push(dp);
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dp, lines };
}

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.stop()));
});

describe('DetectorProcess', () => {
  it('frames pcm and announces the epoch first', async () => {
    const { dp, lines } = make();
    dp.start();
    const pcm = new PassThrough();
    dp.attachPcm(pcm, 7);
    await until(() => dp.health().running);
    pcm.write(Buffer.alloc(1000));
    await until(() => lines().length >= 2);
    expect(lines()[0]).toBe('1 {"type":"epoch","epoch":7,"startMs":0}');
    expect(lines()[1]).toBe('0 1000');
  });

  it('splits pcm into frames of at most 64 KB', async () => {
    const { dp, lines } = make();
    dp.start();
    const pcm = new PassThrough();
    dp.attachPcm(pcm, 1);
    await until(() => dp.health().running);
    pcm.write(Buffer.alloc(150_000));
    await until(() => lines().length >= 4);
    const sizes = lines().slice(1).map((l) => Number(l.split(' ')[1]));
    expect(sizes.every((s) => s <= 65536)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(150_000);
  });

  it("emits 'event' for event lines and ignores malformed lines", async () => {
    const { dp } = make(['--event']);
    const events: any[] = [];
    const signals: any[] = [];
    const near: any[] = [];
    dp.on('event', (e) => events.push(e));
    dp.on('signals', (s) => signals.push(s));
    dp.on('nearmiss', (n) => near.push(n));
    dp.start();
    dp.attachPcm(new PassThrough(), 3);
    await until(() => events.length === 1 && signals.length >= 1 && near.length >= 1);
    expect(events[0].epoch).toBe(3);
    expect(events[0].type).toBeUndefined();
    expect(events[0].triggers).toEqual(['laugh']);
    expect(signals[0].type).toBeUndefined();
    expect(near[0].kind).toBe('x');
  });

  it('restarts a crashed detector and re-announces the current epoch', async () => {
    const { dp, lines } = make(['--crash-after', '1']);
    dp.start();
    dp.attachPcm(new PassThrough(), 5);
    await until(() => dp.health().restarts >= 1 && lines().filter((l) => l.startsWith('1 {"type":"epoch","epoch":5,')).length >= 2);
    expect(dp.health().restarts).toBeGreaterThanOrEqual(1);
  });

  it('re-announces the epoch after a restart with startMs = pcm bytes received / 32', async () => {
    const { dp, lines } = make(['--crash-after', '2'], { restartDelaysMs: [400] });
    dp.start();
    const pcm = new PassThrough();
    dp.attachPcm(pcm, 5);
    await until(() => dp.health().running);
    pcm.write(Buffer.alloc(3200)); // forwarded, then the detector crashes
    await until(() => !dp.health().running);
    pcm.write(Buffer.alloc(6401)); // dropped while the detector is down (odd length on purpose)
    await new Promise((r) => setImmediate(r));
    await until(() => dp.health().running);
    pcm.write(Buffer.alloc(320));
    await until(() => lines().length >= 4);
    expect(lines()).toEqual([
      '1 {"type":"epoch","epoch":5,"startMs":0}',
      '0 3200',
      '1 {"type":"epoch","epoch":5,"startMs":300}', // floor(9601 / 32)
      '0 319', // first byte skipped to keep s16 samples aligned
    ]);
  });

  it('sends a resync frame with the stream time before forwarding pcm after drops', async () => {
    const { dp, lines } = make(['--pause-ms', '700']);
    dp.start();
    const pcm = new PassThrough({ highWaterMark: 1024 });
    dp.attachPcm(pcm, 2);
    await until(() => dp.health().running);
    const K = 64000; // 2000 ms of audio per chunk
    let written = 0;
    for (let i = 0; i < 150; i++) {
      pcm.write(Buffer.alloc(K));
      written += K;
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setTimeout(r, 900)); // the detector reads again, stdin drains
    pcm.write(Buffer.alloc(K));
    written += K;
    await until(() => lines().some((l) => l.includes('"resync"')));
    await until(() => {
      const ls = lines();
      const i = ls.findIndex((l) => l.includes('"resync"'));
      return i >= 0 && i + 1 < ls.length;
    });
    const ls = lines();
    const i = ls.findIndex((l) => l.includes('"resync"'));
    const msg = JSON.parse(ls[i].slice(2));
    const before = ls.slice(0, i).filter((l) => l.startsWith('0 ')).reduce((a, l) => a + Number(l.slice(2)), 0);
    expect(msg.type).toBe('resync');
    expect(msg.tMs % 2000).toBe(0); // a chunk boundary in stream time
    expect(msg.tMs * 32).toBeGreaterThan(before); // some audio was dropped in between
    expect(msg.tMs * 32).toBeLessThan(written);
    expect(ls[i + 1].startsWith('0 ')).toBe(true);
    expect(ls.filter((l) => l.includes('"resync"')).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps consuming the pcm stream while the detector is dead', async () => {
    const { dp } = make([], { command: 'no-such-python-xyz', args: [], restartDelaysMs: [60_000] });
    dp.start();
    const pcm = new PassThrough({ highWaterMark: 1024 });
    dp.attachPcm(pcm, 1);
    let written = 0;
    for (let i = 0; i < 200; i++) {
      pcm.write(Buffer.alloc(1024));
      written += 1024;
      await new Promise((r) => setImmediate(r));
    }
    expect(dp.health().running).toBe(false);
    expect(pcm.readableLength).toBeLessThan(4096);
    expect(written).toBeGreaterThan(100_000);
  });

  it('discards pcm instead of buffering when stdin is backpressured', async () => {
    // detector that never reads stdin
    const { dp } = make([], { args: ['-e', 'setInterval(()=>process.stdout.write("{\\"type\\":\\"heartbeat\\"}\\n"),50)'] });
    dp.start();
    const pcm = new PassThrough({ highWaterMark: 1024 });
    dp.attachPcm(pcm, 1);
    await until(() => dp.health().running);
    for (let i = 0; i < 300; i++) {
      pcm.write(Buffer.alloc(65536));
      await new Promise((r) => setImmediate(r));
    }
    expect(pcm.readableLength).toBeLessThan(4096);
  });

  it('keeps draining the pcm stream after stop() and after re-attach', async () => {
    const { dp } = make();
    dp.start();
    const first = new PassThrough({ highWaterMark: 1024 });
    dp.attachPcm(first, 1);
    await until(() => dp.health().running);
    const second = new PassThrough({ highWaterMark: 1024 });
    dp.attachPcm(second, 2);
    for (let i = 0; i < 50; i++) {
      first.write(Buffer.alloc(1024));
      await new Promise((r) => setImmediate(r));
    }
    expect(first.readableLength).toBeLessThan(4096);
    expect(first.listenerCount('error')).toBe(1);
    await dp.stop();
    for (let i = 0; i < 50; i++) {
      second.write(Buffer.alloc(1024));
      await new Promise((r) => setImmediate(r));
    }
    expect(second.readableLength).toBeLessThan(4096);
  });

  it('restarts when heartbeats stop', async () => {
    const { dp } = make(['--no-heartbeat'], { heartbeatTimeoutMs: 200 });
    dp.start();
    await until(() => dp.health().restarts >= 1, 4000);
    expect(dp.health().restarts).toBeGreaterThanOrEqual(1);
  });

  it('reports chat status changes through health', async () => {
    const { dp } = make(['--chat', 'connected']);
    const seen: string[] = [];
    dp.on('health', (h) => seen.push(h.chat));
    expect(dp.health().chat).toBe('unknown');
    dp.start();
    await until(() => dp.health().chat === 'connected');
    expect(seen).toContain('connected');
  });

  it('stop() resolves even if the process ignores the stop frame', async () => {
    const { dp } = make(['--ignore-stop'], { stopTimeoutMs: 300 });
    dp.start();
    await until(() => dp.health().running);
    await dp.stop();
    expect(dp.health().running).toBe(false);
  });

  it('stop() resolves only after the event the detector prints on the stop frame was emitted', async () => {
    const { dp } = make(['--event-on-stop']);
    const events: any[] = [];
    dp.on('event', (e) => events.push(e));
    dp.start();
    await until(() => dp.health().running);
    await dp.stop();
    expect(events.map((e) => e.epoch)).toEqual([99]);
  });

  it('logs the exit code with the stderr tail and reports the last error in health', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    try {
      const { dp } = make(['--fail', 'ModuleNotFoundError: No module named numpy'], { restartDelaysMs: [20] });
      dp.start();
      await until(() => dp.health().restarts >= 3);
      expect(dp.health().lastError).toBe('ModuleNotFoundError: No module named numpy');
      expect(errors[0]).toContain('код 3');
      expect(errors[0]).toContain('ModuleNotFoundError: No module named numpy');
      // the same failure repeating is logged once, not on every restart
      expect(errors.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a spawn error in health', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { dp } = make([], { command: 'no-such-python-xyz', args: [] });
      dp.start();
      await until(() => dp.health().lastError !== undefined);
      expect(dp.health().lastError).toMatch(/ENOENT/);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails softly when the command does not exist', async () => {
    const { dp } = make([], { command: 'no-such-python-xyz', args: [] });
    dp.start();
    dp.attachPcm(new PassThrough(), 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(dp.health().running).toBe(false);
  });

  it('sends the config before the epoch and reports the acknowledgement', async () => {
    const { dp, lines } = make();
    expect(dp.setConfig(D1)).toBe(1);
    const acks: unknown[] = [];
    dp.on('config', (s) => acks.push(s));
    dp.start();
    dp.attachPcm(new PassThrough(), 7);
    await until(() => lines().length >= 2);
    expect(JSON.parse(lines()[0]!.slice(2))).toEqual({ type: 'config', version: 1, detector: D1 });
    expect(lines()[1]).toBe('1 {"type":"epoch","epoch":7,"startMs":0}');
    await until(() => dp.configState().applied === 1);
    expect(acks.at(-1)).toEqual({ sent: 1, applied: 1, badPatterns: [] });
  });

  it('sends a changed config to the running process at once', async () => {
    const { dp, lines } = make();
    dp.setConfig(D1);
    dp.start();
    dp.attachPcm(new PassThrough(), 4);
    await until(() => dp.configState().applied === 1);
    const D2 = { ...D1, chat: { ...D1.chat, minTriggerShare: 0.2 } };
    expect(dp.setConfig(D2)).toBe(2);
    await until(() => dp.configState().applied === 2);
    const frames = lines().filter((l) => l.startsWith('1 ')).map((l) => JSON.parse(l.slice(2)));
    expect(frames.map((f) => f.type)).toEqual(['config', 'epoch', 'config']);
    expect(frames[2]).toEqual({ type: 'config', version: 2, detector: D2 });
  });

  it('re-sends the latest config, not the first one, after a crash', async () => {
    const { dp, lines } = make(['--crash-after', '3']);
    dp.setConfig(D1);
    dp.start();
    dp.attachPcm(new PassThrough(), 1);
    await until(() => dp.health().running);
    const D2 = { ...D1, chat: { ...D1.chat, minTriggerShare: 0.2 } };
    dp.setConfig(D2);
    await until(() => dp.health().restarts >= 1 && dp.health().running);
    await until(() => lines().filter((l) => l.includes('"type":"config"')).length >= 3);
    const frames = lines().filter((l) => l.startsWith('1 ')).map((l) => JSON.parse(l.slice(2)));
    const afterRestart = frames.slice(frames.findLastIndex((f) => f.type === 'config'));
    expect(afterRestart[0]).toEqual({ type: 'config', version: 2, detector: D2 });
    expect(afterRestart[1]?.type).toBe('epoch');
  });

  it('never sends a config frame when setConfig was not called', async () => {
    const { dp, lines } = make();
    dp.start();
    dp.attachPcm(new PassThrough(), 1);
    await until(() => lines().length >= 1);
    expect(lines().some((l) => l.includes('"type":"config"'))).toBe(false);
    expect(dp.configState()).toEqual({ sent: 0, applied: 0, badPatterns: [] });
  });

  it('reports patterns the detector could not use', async () => {
    const { dp } = make(['--bad-pattern', '((']);
    dp.setConfig(D1);
    dp.start();
    await until(() => dp.configState().applied === 1);
    expect(dp.configState().badPatterns).toEqual(['((']);
  });

  it('reports a refused config with its error', async () => {
    const { dp } = make(['--config-error', 'bad value']);
    const acks: unknown[] = [];
    dp.on('config', (s) => acks.push(s));
    dp.setConfig(D1);
    dp.start();
    await until(() => dp.configState().applied === 1);
    const expected = { sent: 1, applied: 1, badPatterns: [], error: 'bad value' };
    expect(dp.configState()).toEqual(expected);
    expect(acks.at(-1)).toEqual(expected);
  });

  it('passes detail through on signals lines', async () => {
    const { dp } = make(['--signals-detail']);
    const signals: any[] = [];
    dp.on('signals', (s) => signals.push(s));
    dp.start();
    await until(() => signals.some((s) => s.detail));
    const detail = signals.find((s) => s.detail).detail;
    expect(detail.configVersion).toBe(0);
    expect(detail.chat.triggerShare).toBe(1);
    expect(detail.event).toBeNull();
  });
});
