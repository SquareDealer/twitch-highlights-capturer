import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CaptureOptions, CaptureProcs, ProbeResult, ProcessRunner } from '../../src/main/capture/processes';
import { openDb, type Db } from '../../src/main/db';
import { defaultConfig, type ServiceConfig } from '../../src/service/config';
import type { DetectorHealth, DetectorProcess } from '../../src/service/detectorProcess';
import { appendNearMiss } from '../../src/service/nearMissLog';
import { parseChannelUrl, StreamRegistry } from '../../src/service/streams';
import type { DetectorEvent, FeedClip } from '../../src/service/types';
import { tmpDir } from '../helpers';

const R4 = 'Это не ссылка на канал Twitch';

class FakeRunner implements ProcessRunner {
  probes: ProbeResult[] = [];
  spawned: Array<{ channel: string; epochDir: string; pcm: Readable; exit: (reason: string) => void; stopped: boolean }> = [];
  async probe() {
    return this.probes.shift() ?? { live: true as const, streamId: '777', qualities: ['best', '720p60'] };
  }
  checkThrows: Error | null = null;
  async checkBinaries() {
    if (this.checkThrows) throw this.checkThrows;
    return null;
  }
  spawnCapture(channel: string, epochDir: string, opts: CaptureOptions): CaptureProcs {
    let cb: (reason: string) => void = () => {};
    const pcm = new Readable({ read() {} });
    const entry = { channel, epochDir, pcm, exit: (r: string) => cb(r), stopped: false };
    this.spawned.push(entry);
    return { pcm: opts.pcm ? pcm : null, onExit: (f) => void (cb = f), stop: async () => void (entry.stopped = true) };
  }
}

class FakeDetector extends EventEmitter {
  attached: Array<{ pcm: Readable; epoch: number }> = [];
  started = false;
  stopped = false;
  /** Runs inside stop(), like the real detector flushing its open event on the stop frame. */
  onStop: (() => void) | null = null;
  constructor(readonly channel: string, private readonly log: string[]) {
    super();
  }
  start() {
    this.started = true;
  }
  attachPcm(pcm: Readable, epoch: number) {
    this.attached.push({ pcm, epoch });
  }
  health(): DetectorHealth {
    return { running: this.started && !this.stopped, chat: 'unknown', restarts: 0 };
  }
  async stop() {
    this.stopped = true;
    this.log.push(`detector.stop ${this.channel}`);
    this.onStop?.();
  }
}

let db: Db;
let cfg: ServiceConfig;
let configFile: string;
let runner: FakeRunner;
let detectors: Map<string, FakeDetector>;
let log: string[];
let concatCalls: Array<{ segs: string[]; existed: boolean }>;
let registry: StreamRegistry;
let notices: Array<{ level: string; message: string }>;
let clips: FeedClip[];

const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 3000, interval: 5 });

function build(over: Partial<ServiceConfig> = {}) {
  const dir = tmpDir();
  cfg = { ...defaultConfig(dir), password: 'x', diskReserveBytes: 0, preRollMs: 0, postRollMs: 0, ...over };
  configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ password: 'x', port: 9000 }));
  registry = new StreamRegistry({
    db, config: () => cfg, configFile, cuttingPaused: () => false, runner,
    makeDetector: (ch) => {
      const d = new FakeDetector(ch, log);
      detectors.set(ch, d);
      return d as unknown as DetectorProcess;
    },
    concat: async (segs, out) => {
      concatCalls.push({ segs, existed: segs.every((s) => existsSync(s)) });
      log.push('concat');
      writeFileSync(out, segs.join('\n'));
    },
    sleep: async () => {},
    pollMs: 5,
  });
  registry.on('notice', (n) => notices.push(n));
  registry.on('clip', (c: FeedClip) => clips.push(c));
}

beforeEach(() => {
  db = openDb(':memory:');
  runner = new FakeRunner();
  detectors = new Map();
  log = [];
  concatCalls = [];
  notices = [];
  clips = [];
  build();
});
afterEach(async () => {
  await registry.shutdown();
});

/** Simulates FFmpeg finishing 2-second segment `seq` in the given epoch directory. */
function feed(epochDir: string, seq: number) {
  mkdirSync(epochDir, { recursive: true });
  const file = `seg_${String(seq).padStart(6, '0')}.ts`;
  writeFileSync(join(epochDir, file), 'x'.repeat(10));
  appendFileSync(join(epochDir, 'segments.csv'), `${file},${(seq * 2).toFixed(6)},${(seq * 2 + 2).toFixed(6)}\n`);
}
const spawnOf = (channel: string) => runner.spawned.filter((s) => s.channel === channel).at(-1)!;
const segmentRows = () => db.prepare('SELECT session_id AS s FROM buffer_segments').all() as Array<{ s: string }>;

const event = (over: Partial<DetectorEvent> = {}): DetectorEvent => ({
  epoch: 0, startMs: 0, endMs: 2000, triggerTimeMs: 1000, estimatedEventMs: 1000, uncertaintyMs: 0,
  triggers: ['laugh'], confidence: 'normal', scores: { S: 0.7, C: 0.5, E: 0.5, U: 0.5, A: 0.5 },
  signals: { chatSpike: 4, laughShare: 0.5, reactionShare: 0.1, deltaDb: 3 }, ...over,
});

async function startOk(url: string) {
  const r = await registry.start(url, 'best');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('parseChannelUrl', () => {
  it('accepts channel links and rejects VODs, reserved paths, bare logins and empty strings', () => {
    expect(parseChannelUrl('https://www.twitch.tv/Foo_Bar')).toBe('foo_bar');
    expect(parseChannelUrl('twitch.tv/alice/')).toBe('alice');
    expect(parseChannelUrl('m.twitch.tv/alice?ref=x')).toBe('alice');
    for (const bad of ['', '   ', 'alice', 'https://www.twitch.tv/videos/123456', 'twitch.tv/directory', 'twitch.tv/settings', 'twitch.tv/p/about', 'https://youtube.com/alice']) {
      expect(parseChannelUrl(bad)).toBeNull();
    }
  });

  it('start and probe answer with the R4 message for a VOD link', async () => {
    expect(await registry.start('https://www.twitch.tv/videos/123', 'best')).toEqual({ ok: false, error: R4 });
    expect(await registry.probe('')).toEqual({ ok: false, error: R4 });
    expect(await registry.probe('twitch.tv/alice')).toEqual({ ok: true, value: { channel: 'alice', qualities: ['best', '720p60'] } });
  });
});

it('reports an offline channel and keeps nothing in the registry', async () => {
  runner.probes = [{ live: false, reason: 'offline' }];
  expect(await registry.start('twitch.tv/alice', 'best')).toEqual({ ok: false, error: 'Канал не в эфире' });
  expect(registry.list()).toEqual([]);
  expect(detectors.get('alice')!.stopped).toBe(true);
});

it('cleans up the stream and its detector when the capture manager rejects on start', async () => {
  runner.checkThrows = new Error('spawn EACCES');
  expect(await registry.start('twitch.tv/alice', 'best')).toEqual({ ok: false, error: 'spawn EACCES' });
  expect(registry.list()).toEqual([]);
  expect(detectors.get('alice')!.stopped).toBe(true);
  runner.checkThrows = null;
  expect((await registry.start('twitch.tv/alice', 'best')).ok).toBe(true); // nothing left blocks the channel
});

it('rejects a second stream in single mode with the limit message', async () => {
  await startOk('twitch.tv/alice');
  expect(await registry.start('twitch.tv/bob', 'best')).toEqual({
    ok: false,
    error: 'Достигнут лимит одновременных эфиров (1). Остановите один из эфиров или включите режим «несколько эфиров»',
  });
  expect(registry.list().map((s) => s.channel)).toEqual(['alice']);
});

it('runs up to maxStreams in multi mode, each with its own buffer directory', async () => {
  build({ multiStream: true, maxStreams: 2 });
  const a = await startOk('twitch.tv/alice');
  const b = await startOk('https://www.twitch.tv/bob');
  expect(registry.mode()).toEqual({ multiStream: true, limit: 2 });
  expect(await registry.start('twitch.tv/carol', 'best')).toEqual({
    ok: false,
    error: 'Достигнут лимит одновременных эфиров (2). Остановите один из эфиров',
  });
  expect(spawnOf('alice').epochDir).toBe(join(cfg.bufferDir, a.id, 'e0'));
  expect(spawnOf('bob').epochDir).toBe(join(cfg.bufferDir, b.id, 'e0'));
  expect(a.id).not.toBe(b.id);
  expect(registry.list()).toHaveLength(2);
});

it('refuses to leave multi mode while two streams are running', async () => {
  build({ multiStream: true });
  await startOk('twitch.tv/alice');
  await startOk('twitch.tv/bob');
  expect(registry.setMultiStream(false)).toEqual({
    ok: false, error: 'Сначала остановите лишние эфиры: в режиме «один эфир» может идти только один',
  });
  expect(registry.mode().multiStream).toBe(true);
  await registry.stop(registry.list()[1]!.id);
  expect(registry.setMultiStream(false)).toEqual({ ok: true, value: null });
  expect(registry.mode()).toEqual({ multiStream: false, limit: 1 });
});

it('persists the mode to the config file', () => {
  expect(registry.setMultiStream(true)).toEqual({ ok: true, value: null });
  expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ password: 'x', port: 9000, multiStream: true });
  expect(registry.mode()).toEqual({ multiStream: true, limit: cfg.maxStreams });
});

it('rejects a duplicate channel', async () => {
  build({ multiStream: true });
  await startOk('twitch.tv/alice');
  expect(await registry.start('https://www.twitch.tv/Alice/', 'best')).toEqual({ ok: false, error: 'Этот канал уже записывается' });
});

it('routes a detector event of stream A only to the cutter of stream A', async () => {
  build({ multiStream: true });
  const a = await startOk('twitch.tv/alice');
  const b = await startOk('twitch.tv/bob');
  feed(spawnOf('alice').epochDir, 0);
  feed(spawnOf('bob').epochDir, 0);
  await until(() => registry.list().every((s) => s.state === 'RECORDING'));
  detectors.get('alice')!.emit('event', event());
  await until(() => clips.some((c) => c.status === 'new'));
  expect(clips.every((c) => c.sessionId === a.id && c.streamer === 'alice')).toBe(true);
  expect(concatCalls).toHaveLength(1);
  expect(concatCalls[0]!.segs.every((p) => p.startsWith(join(cfg.bufferDir, a.id)))).toBe(true);
  await until(() => registry.list().find((s) => s.id === a.id)!.clipsCreated === 1);
  expect(registry.list().find((s) => s.id === b.id)!.clipsCreated).toBe(0);
});

it('re-attaches pcm to the detector on reconnect with the new epoch', async () => {
  await startOk('twitch.tv/alice');
  const det = detectors.get('alice')!;
  expect(det.started).toBe(true);
  expect(det.attached.map((x) => x.epoch)).toEqual([0]);
  expect(det.attached[0]!.pcm).toBe(runner.spawned[0]!.pcm);
  runner.spawned[0]!.exit('network');
  await until(() => det.attached.length === 2);
  expect(det.attached[1]).toEqual({ pcm: runner.spawned[1]!.pcm, epoch: 1 });
});

it('flushes pending clips before the buffer is cleared on stop', async () => {
  const s = await startOk('twitch.tv/alice');
  const dir = spawnOf('alice').epochDir;
  feed(dir, 0);
  feed(dir, 1);
  await until(() => registry.list()[0]!.bufferedMs === 4000);
  // the clip needs footage up to 10 s: the cutter waits for the tail until stop flushes it
  detectors.get('alice')!.emit('event', event({ endMs: 10_000 }));
  await until(() => clips.some((c) => c.status === 'pending'));
  await registry.stop(s.id);
  expect(concatCalls).toHaveLength(1);
  expect(concatCalls[0]!.existed).toBe(true);
  expect(clips.at(-1)!.status).toBe('new');
  expect(log).toEqual(['detector.stop alice', 'concat']);
  expect(existsSync(join(dir, 'seg_000000.ts'))).toBe(false);
  expect(registry.list()).toEqual([]);
});

it('cuts the event the detector flushes on stop from what exists, before the buffer is cleared', async () => {
  const s = await startOk('twitch.tv/alice');
  const dir = spawnOf('alice').epochDir;
  feed(dir, 0);
  feed(dir, 1);
  await until(() => registry.list()[0]!.bufferedMs === 4000);
  const det = detectors.get('alice')!;
  // the open event is only emitted when the detector gets the stop frame; its tail (10 s) never comes
  det.onStop = () => det.emit('event', event({ endMs: 10_000 }));
  await registry.stop(s.id);
  expect(concatCalls).toHaveLength(1);
  expect(concatCalls[0]!.existed).toBe(true);
  expect(clips.at(-1)!.status).toBe('new');
  expect(log).toEqual(['detector.stop alice', 'concat']);
});

it("removes the stream and emits a notice on 'ended'", async () => {
  build({ offlineEndMs: 0 });
  await startOk('twitch.tv/alice');
  runner.probes = [{ live: false, reason: 'offline' }];
  runner.spawned[0]!.exit('stream over');
  await until(() => registry.list().length === 0);
  expect(notices).toContainEqual({ level: 'info', message: 'Эфир alice завершился' });
  expect(detectors.get('alice')!.stopped).toBe(true);
});

it('stopping one stream leaves the segments of the other in the table', async () => {
  build({ multiStream: true });
  const a = await startOk('twitch.tv/alice');
  const b = await startOk('twitch.tv/bob');
  feed(spawnOf('alice').epochDir, 0);
  feed(spawnOf('bob').epochDir, 0);
  feed(spawnOf('bob').epochDir, 1);
  await until(() => segmentRows().length === 3);
  await registry.stop(a.id);
  expect(segmentRows()).toEqual([{ s: b.id }, { s: b.id }]);
  expect(existsSync(join(spawnOf('bob').epochDir, 'seg_000000.ts'))).toBe(true);
});

it('writes near-misses to the jsonl log', async () => {
  await startOk('twitch.tv/alice');
  detectors.get('alice')!.emit('nearmiss', { tMs: 5000, S: 0.4 });
  detectors.get('alice')!.emit('nearmiss', { tMs: 9000, S: 0.45 });
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = join(cfg.dataDir, 'nearmiss', 'alice', `${day}.jsonl`);
  expect(readFileSync(file, 'utf8')).toBe('{"tMs":5000,"S":0.4}\n{"tMs":9000,"S":0.45}\n');
  appendNearMiss(cfg.dataDir, 'bob', { x: 1 });
  expect(readFileSync(join(cfg.dataDir, 'nearmiss', 'bob', `${day}.jsonl`), 'utf8')).toBe('{"x":1}\n');
});
