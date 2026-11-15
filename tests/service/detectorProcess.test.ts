import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DetectorProcess, type DetectorProcessOptions } from '../../src/service/detectorProcess';

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
    expect(lines()[0]).toBe('1 epoch:7');
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
    await until(() => dp.health().restarts >= 1 && lines().filter((l) => l === '1 epoch:5').length >= 2);
    expect(dp.health().restarts).toBeGreaterThanOrEqual(1);
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

  it('fails softly when the command does not exist', async () => {
    const { dp } = make([], { command: 'no-such-python-xyz', args: [] });
    dp.start();
    dp.attachPcm(new PassThrough(), 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(dp.health().running).toBe(false);
  });
});
