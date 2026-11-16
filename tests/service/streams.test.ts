import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CaptureOptions, CaptureProcs, ProbeResult, ProcessRunner } from '../../src/main/capture/processes';
import { openDb, type Db } from '../../src/main/db';
import { defaultConfig, type ServiceConfig } from '../../src/service/config';
import type { DetectorHealth, DetectorProcess } from '../../src/service/detectorProcess';
import { appendNearMiss } from '../../src/service/nearMissLog';
import { settingsFromConfig } from '../../src/service/profileSettings';
import { ProfileService, type ProfileResult } from '../../src/service/profiles';
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
  configs: unknown[] = [];
  applied = 0;
  badPatterns: string[] = [];
  error: string | undefined;
  /** How many configs had been sent when start() was called. */
  configsAtStart = -1;
  constructor(readonly channel: string, private readonly log: string[]) {
    super();
  }
  start() {
    this.configsAtStart = this.configs.length;
    this.started = true;
  }
  attachPcm(pcm: Readable, epoch: number) {
    this.attached.push({ pcm, epoch });
  }
  setConfig(d: unknown) {
    this.configs.push(d);
    return this.configs.length;
  }
  configState() {
    return { sent: this.configs.length, applied: this.applied, badPatterns: this.badPatterns, ...(this.error !== undefined ? { error: this.error } : {}) };
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
let profiles: ProfileService;

function ok<T>(r: ProfileResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 3000, interval: 5 });

function build(over: Partial<ServiceConfig> = {}) {
  const dir = tmpDir();
  cfg = { ...defaultConfig(dir), password: 'x', diskReserveBytes: 0, preRollMs: 0, postRollMs: 0, ...over };
  configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ password: 'x', port: 9000 }));
  profiles = new ProfileService(db, () => settingsFromConfig(cfg));
  registry = new StreamRegistry({
    db, config: () => cfg, configFile, cuttingPaused: () => false, runner, profiles,
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
  triggers: ['laugh'], confidence: 'normal', scores: { total: 0.7, share: 0, speed: 0, audio: 0 },
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
    expect(await registry.probe('twitch.tv/alice')).toEqual({
      ok: true, value: { channel: 'alice', qualities: ['best', '720p60'], profileId: profiles.defaultProfile().id },
    });
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

describe('profiles', () => {
  it('starts a stream on the remembered profile and sends it before the detector starts', async () => {
    const big = ok(profiles.create('Крупный канал'));
    profiles.remember('alice', big.id);
    const r = await registry.start('https://twitch.tv/alice', 'best');
    expect(r.ok && r.value.profile).toEqual({ id: big.id, name: 'Крупный канал' });
    expect(detectors.get('alice')!.configs).toEqual([big.settings.detector]);
    expect(detectors.get('alice')!.configsAtStart).toBe(1);
  });

  it('uses the given profile and remembers it for the channel', async () => {
    const mine = ok(profiles.create('Свой'));
    const r = await registry.start('https://twitch.tv/alice', 'best', mine.id);
    expect(r.ok && r.value.profile).toEqual({ id: mine.id, name: 'Свой' });
    expect(detectors.get('alice')!.configs).toEqual([mine.settings.detector]);
    expect(profiles.forChannel('alice').id).toBe(mine.id);
  });

  it('refuses an unknown profile without starting anything', async () => {
    expect(await registry.start('https://twitch.tv/alice', 'best', 'nope')).toEqual({ ok: false, error: 'Профиль не найден' });
    expect(registry.list()).toEqual([]);
    expect(runner.spawned).toEqual([]);
    expect(detectors.size).toBe(0);
    expect(profiles.forChannel('alice').isDefault).toBe(true);
  });

  it('applies a saved profile to every running stream on it and to no other', async () => {
    build({ multiStream: true, maxStreams: 3 });
    const other = ok(profiles.create('Другой'));
    await registry.start('https://twitch.tv/alice', 'best');
    await registry.start('https://twitch.tv/bob', 'best');
    await registry.start('https://twitch.tv/carol', 'best', other.id);
    const next = structuredClone(profiles.defaultProfile().settings);
    next.detector.chat.minTriggerShare = 0.2;
    ok(profiles.update(profiles.defaultProfile().id, { settings: next }));
    expect(detectors.get('alice')!.configs.at(-1)).toEqual(next.detector);
    expect(detectors.get('bob')!.configs).toHaveLength(2);
    expect(detectors.get('carol')!.configs).toHaveLength(1);
    expect(registry.list().map((s) => s.profileVersion)).toEqual([2, 2, 1]);
  });

  it('a failing listener does not break a profile update, and shutdown unsubscribes', async () => {
    const s = await startOk('twitch.tv/alice');
    const d = detectors.get('alice')!;
    d.setConfig = () => {
      throw new Error('boom');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const next = structuredClone(profiles.defaultProfile().settings);
    next.detector.chat.minTriggerShare = 0.2;
    expect(profiles.update(profiles.defaultProfile().id, { settings: next }).ok).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    await registry.stop(s.id);
    const before = profiles.listenerCount('updated');
    await registry.shutdown();
    expect(profiles.listenerCount('updated')).toBe(before - 1);
  });

  it('switches the profile of a running stream', async () => {
    const other = ok(profiles.create('Другой'));
    const s = await startOk('twitch.tv/alice');
    expect(s.profile.name).toBe('По умолчанию');
    const r = registry.setProfile(s.id, other.id);
    expect(r.ok && r.value.profile).toEqual({ id: other.id, name: 'Другой' });
    const d = detectors.get('alice')!;
    expect(d.configs).toHaveLength(2);
    expect(d.configs.at(-1)).toEqual(other.settings.detector);
    expect(profiles.forChannel('alice').id).toBe(other.id);
    expect(registry.list()[0]!.profile).toEqual({ id: other.id, name: 'Другой' });
    feed(spawnOf('alice').epochDir, 0);
    await until(() => registry.list()[0]!.state === 'RECORDING');
    d.emit('event', event());
    await until(() => clips.some((c) => c.status === 'new'));
    expect(clips.at(-1)!.profileName).toBe('Другой');
    expect(clips.at(-1)!.profileId).toBe(other.id);
  });

  it('reports unknown stream and unknown profile on setProfile', async () => {
    const s = await startOk('twitch.tv/alice');
    expect(registry.setProfile('nope', profiles.defaultProfile().id)).toEqual({ ok: false, error: 'Эфир не найден' });
    expect(registry.setProfile(s.id, 'nope')).toEqual({ ok: false, error: 'Профиль не найден' });
    expect(detectors.get('alice')!.configs).toHaveLength(1);
    expect(registry.list()[0]!.profile.id).toBe(profiles.defaultProfile().id);
  });

  it('knows which profiles are in use', async () => {
    const other = ok(profiles.create('Другой'));
    const s = await startOk('twitch.tv/alice');
    expect(registry.profileInUse(profiles.defaultProfile().id)).toBe(true);
    expect(registry.profileInUse(other.id)).toBe(false);
    await registry.stop(s.id);
    expect(registry.profileInUse(profiles.defaultProfile().id)).toBe(false);
  });

  it('probe returns the remembered profile of the channel', async () => {
    const big = ok(profiles.create('Крупный канал'));
    profiles.remember('bob', big.id);
    const r = await registry.probe('twitch.tv/bob');
    expect(r.ok && r.value.profileId).toBe(big.id);
    const a = await registry.probe('twitch.tv/alice');
    expect(a.ok && a.value.profileId).toBe(profiles.defaultProfile().id);
  });

  it('keeps frames and decisions for the tuning panel and emits them', async () => {
    const seen: any[] = [];
    registry.on('tuning', (e) => seen.push(e));
    const r = await registry.start('https://twitch.tv/alice', 'best');
    const id = r.ok ? r.value.id : '';
    const d = detectors.get('alice')!;
    d.emit('signals', { tMs: 1000, chatSpike: 1, laughShare: 0, messages: 0, deltaDb: 0, vad: 0, warm: false });
    d.emit('nearmiss', { epoch: 1, tMs: 2000, kind: 'chat', missing: ['share'], values: { triggerShare: 0.03 } });
    d.applied = 1;
    d.emit('config', { sent: 1, applied: 1, badPatterns: ['(('] });
    const t = registry.tuning(id)!;
    expect(t.frames).toHaveLength(1);
    expect(t.entries.map((e) => e.kind)).toEqual(['nearmiss', 'profile']);
    expect(t.entries[1]).toMatchObject({ name: 'По умолчанию', version: 1, badPatterns: ['(('] });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ streamId: id, entry: { kind: 'nearmiss', missing: ['share'] } });
    expect(registry.tuning('nope')).toBeNull();
  });

  it('logs a refused config with its error', async () => {
    const s = await startOk('twitch.tv/alice');
    detectors.get('alice')!.emit('config', { sent: 1, applied: 1, badPatterns: [], error: 'bad value' });
    expect(registry.tuning(s.id)!.entries).toEqual([
      expect.objectContaining({ kind: 'profile', version: 1, badPatterns: [], error: 'bad value' }),
    ]);
  });

  it('logs cutter decisions', async () => {
    const s = await startOk('twitch.tv/alice');
    feed(spawnOf('alice').epochDir, 0);
    await until(() => registry.list()[0]!.state === 'RECORDING');
    detectors.get('alice')!.emit('event', event());
    await until(() => clips.some((c) => c.status === 'new'));
    const entries = registry.tuning(s.id)!.entries;
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'clip', clipId: clips.at(-1)!.id, triggers: ['laugh'], scores: event().scores }),
    ]);
    expect(typeof entries[0]!.at).toBe('string');
  });

  it('status carries the profile versions and bad patterns', async () => {
    const s = await startOk('twitch.tv/alice');
    expect(s).toMatchObject({ profileVersion: 1, profileApplied: 0, profileBadPatterns: [] });
    const d = detectors.get('alice')!;
    d.applied = 1;
    d.badPatterns = ['(('];
    expect(registry.list()[0]).toMatchObject({ profileVersion: 1, profileApplied: 1, profileBadPatterns: ['(('] });
  });

  it('status carries the error of a refused config', async () => {
    const s = await startOk('twitch.tv/alice');
    expect(s.profileError).toBeUndefined();
    const d = detectors.get('alice')!;
    d.applied = 1;
    d.error = 'bad value';
    d.emit('config', { sent: 1, applied: 1, badPatterns: [], error: 'bad value' });
    expect(registry.list()[0]).toMatchObject({ profileApplied: 1, profileError: 'bad value' });
  });
});
