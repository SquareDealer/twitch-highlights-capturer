import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CaptureOptions, CaptureProcs, ProbeResult, ProcessRunner } from '../../src/main/capture/processes';
import { openDb } from '../../src/main/db';
import { createClipRepo } from '../../src/service/clipRepo';
import type { DetectorHealth, DetectorProcess } from '../../src/service/detectorProcess';
import { runService } from '../../src/service/main';
import { StreamRegistry, type StreamRegistryDeps } from '../../src/service/streams';
import type { DetectorEvent, FeedClip } from '../../src/service/types';
import { tmpDir } from '../helpers';

const PASSWORD = 'secret-pass';

class FakeRunner implements ProcessRunner {
  spawned: Array<{ channel: string; epochDir: string; pcm: Readable }> = [];
  async probe(): Promise<ProbeResult> {
    return { live: true, streamId: '777', qualities: ['best'] };
  }
  async checkBinaries() {
    return null;
  }
  spawnCapture(channel: string, epochDir: string, opts: CaptureOptions): CaptureProcs {
    const pcm = new Readable({ read() {} });
    this.spawned.push({ channel, epochDir, pcm });
    return { pcm: opts.pcm ? pcm : null, onExit: () => {}, stop: async () => {} };
  }
}

class FakeDetector extends EventEmitter {
  private sent = 0;
  start() {}
  attachPcm() {}
  setConfig() {
    return ++this.sent;
  }
  configState() {
    return { sent: this.sent, applied: 0, badPatterns: [] };
  }
  health(): DetectorHealth {
    return { running: true, chat: 'unknown', restarts: 0 };
  }
  async stop() {}
}

let root: string;
let configFile: string;
let dataDir: string;
let runner: FakeRunner;
let detectors: FakeDetector[];
let concatCalls: number;
let service: Awaited<ReturnType<typeof runService>> | null;

const until = (cond: () => boolean | Promise<boolean>) =>
  vi.waitFor(async () => expect(await cond()).toBe(true), { timeout: 5000, interval: 10 });

function overrides(): Partial<StreamRegistryDeps> {
  return {
    runner,
    makeDetector: () => {
      const d = new FakeDetector();
      detectors.push(d);
      return d as unknown as DetectorProcess;
    },
    concat: async (segs, out) => {
      concatCalls++;
      writeFileSync(out, 'MP4:' + segs.length);
    },
    sleep: async () => {},
    pollMs: 5,
  };
}

function writeConfig(extra: object = {}) {
  writeFileSync(configFile, JSON.stringify({ password: PASSWORD, port: 0, diskReserveBytes: 0, preRollMs: 0, postRollMs: 0, ...extra }));
}

async function start() {
  service = await runService({ configFile, dataDir, overrides: overrides(), host: '127.0.0.1' });
  return `http://127.0.0.1:${service.port}`;
}

async function login(base: string): Promise<string> {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  expect(r.status).toBe(204);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

const get = async (base: string, cookie: string, path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

function feed(epochDir: string, seq: number) {
  mkdirSync(epochDir, { recursive: true });
  const file = `seg_${String(seq).padStart(6, '0')}.ts`;
  writeFileSync(join(epochDir, file), 'x'.repeat(10));
  appendFileSync(join(epochDir, 'segments.csv'), `${file},${(seq * 2).toFixed(6)},${(seq * 2 + 2).toFixed(6)}\n`);
}

const event = (over: Partial<DetectorEvent> = {}): DetectorEvent => ({
  epoch: 0, startMs: 0, endMs: 2000, triggerTimeMs: 1000, estimatedEventMs: 1000, uncertaintyMs: 0,
  triggers: ['laugh'], confidence: 'normal', scores: { total: 0.7, share: 0, speed: 0, audio: 0 },
  signals: { chatSpike: 4, laughShare: 0.5, reactionShare: 0.1, deltaDb: 3 }, ...over,
});

async function startStream(base: string, cookie: string): Promise<string> {
  const r = await fetch(`${base}/api/streams`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.twitch.tv/alice', quality: 'best' }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

beforeEach(() => {
  root = tmpDir();
  configFile = join(root, 'config.json');
  dataDir = join(root, 'data');
  runner = new FakeRunner();
  detectors = [];
  concatCalls = 0;
  service = null;
});
afterEach(async () => {
  await service?.shutdown();
  vi.restoreAllMocks();
});

it('creates a config with a generated password on first run', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  service = await runService({ configFile, dataDir, overrides: overrides(), port: 0, host: '127.0.0.1' });
  const saved = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  expect(saved.password).toMatch(/^[A-Za-z0-9]{16}$/);
  expect(saved.port).toBe(8080);
  expect(saved).not.toHaveProperty('dataDir'); // data location stays with HL_DATA
  const printed = log.mock.calls.map((c) => c.join(' '));
  expect(printed.filter((l) => l.includes(saved.password as string))).toHaveLength(1);
  expect(printed).toContain(`Сервис запущен: http://localhost:${service.port}`);
  expect(existsSync(join(dataDir, 'service.sqlite'))).toBe(true);
});

it('refuses to start when bufferDir would wipe the data directory', async () => {
  writeConfig({ bufferDir: dataDir });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'keep.txt'), 'x');
  await expect(runService({ configFile, dataDir, overrides: overrides(), host: '127.0.0.1' })).rejects.toThrow(/^Папка буфера/);
  expect(existsSync(join(dataDir, 'keep.txt'))).toBe(true);
});

it('closes http and the database even when stopping the streams fails', async () => {
  writeConfig();
  const base = await start();
  const spy = vi.spyOn(StreamRegistry.prototype, 'shutdown').mockRejectedValueOnce(new Error('boom'));
  const svc = service!;
  service = null;
  await expect(svc.shutdown()).rejects.toThrow('boom');
  spy.mockRestore();
  await expect(fetch(`${base}/api/state`)).rejects.toThrow();
  // the database file is closed: it can be removed
  rmSync(join(dataDir, 'service.sqlite'));
});

it('marks clips left pending by a previous run as error', async () => {
  writeConfig();
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'service.sqlite'));
  const leftover: FeedClip = {
    id: 'old', sessionId: 's0', streamer: 'alice', streamId: '1', epoch: 0, startMs: 0, endMs: 1000, durationMs: 0, bytes: 0,
    triggers: ['laugh'], confidence: 'normal', score: 0.5, signals: { chatSpike: 0, laughShare: 0, reactionShare: 0, deltaDb: 0 },
    status: 'pending', error: null, mp4Path: join(root, 'x.mp4'), jsonPath: join(root, 'x.json'), fileDeleted: false,
    createdAt: '2026-11-15T10:00:00.000Z', statusChangedAt: null, profileId: null, profileName: null,
  };
  createClipRepo(db).insert(leftover);
  db.prepare("INSERT INTO buffer_segments (session_id, epoch, seq, path, start_ms, end_ms, bytes, completed_at_wall_ms) VALUES ('s0', 0, 0, 'x', 0, 2000, 1, 0)").run();
  db.close();
  const stale = join(dataDir, 'buffer', 's0', 'epoch_0');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'seg_000000.ts'), 'x');

  vi.spyOn(console, 'log').mockImplementation(() => {});
  const base = await start();
  const cookie = await login(base);
  const clips = (await (await get(base, cookie, '/api/clips')).json()) as FeedClip[];
  expect(clips).toHaveLength(1);
  expect(clips[0]).toMatchObject({ id: 'old', status: 'error', error: 'Сервис был перезапущен до завершения нарезки' });
  expect(existsSync(join(dataDir, 'buffer', 's0'))).toBe(false);
  expect(existsSync(join(dataDir, 'buffer'))).toBe(true);
});

it('end to end: login → start stream → detector event → clip appears in /api/clips as new → media is served', async () => {
  writeConfig();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const base = await start();
  const cookie = await login(base);
  await startStream(base, cookie);
  const dir = runner.spawned[0]!.epochDir;
  feed(dir, 0);
  feed(dir, 1);
  await until(async () => {
    const s = (await (await get(base, cookie, '/api/state')).json()) as { streams: Array<{ bufferedMs: number }> };
    return s.streams[0]?.bufferedMs === 4000;
  });
  detectors[0]!.emit('event', event());
  let clip: FeedClip | undefined;
  await until(async () => {
    const list = (await (await get(base, cookie, '/api/clips?status=new')).json()) as FeedClip[];
    clip = list[0];
    return clip !== undefined;
  });
  expect(clip).toMatchObject({ streamer: 'alice', triggers: ['laugh'] });
  expect(clip).not.toHaveProperty('mp4Path');
  const media = await get(base, cookie, `/media/clips/${clip!.id}.mp4`);
  expect(media.status).toBe(200);
  expect(media.headers.get('content-type')).toBe('video/mp4');
  expect(await media.text()).toMatch(/^MP4:/);
});

it('shutdown flushes a pending clip before exit', async () => {
  writeConfig();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const base = await start();
  const cookie = await login(base);
  await startStream(base, cookie);
  const dir = runner.spawned[0]!.epochDir;
  feed(dir, 0);
  feed(dir, 1);
  await until(async () => {
    const s = (await (await get(base, cookie, '/api/state')).json()) as { streams: Array<{ bufferedMs: number }> };
    return s.streams[0]?.bufferedMs === 4000;
  });
  // needs footage up to 10 s, which never arrives: only the shutdown flush can finish it
  detectors[0]!.emit('event', event({ endMs: 10_000 }));
  await until(async () => ((await (await get(base, cookie, '/api/clips?status=pending')).json()) as FeedClip[]).length === 1);
  await service!.shutdown();
  service = null;
  expect(concatCalls).toBe(1);
  const db = openDb(join(dataDir, 'service.sqlite'));
  const clips = createClipRepo(db).list();
  db.close();
  expect(clips.map((c) => c.status)).toEqual(['new']);
});

it('creates the default profile from config.json on the first start and keeps edits across restarts', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  writeConfig({ preRollMs: 7000, detector: { chat: { minSpike: 2, minTriggerShare: 0.6 } } });
  let base = await start();
  let cookie = await login(base);
  const list = async () => (await (await get(base, cookie, '/api/profiles')).json()) as Array<{ id: string; isDefault: boolean; settings: any }>;
  const [first] = await list();
  expect(first).toMatchObject({ isDefault: true, settings: { cut: { preRollMs: 7000 }, detector: { chat: { minTriggerShare: 0.6 } } } });

  const settings = structuredClone(first!.settings);
  settings.cut.preRollMs = 3000;
  const put = await fetch(`${base}/api/profiles/${first!.id}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  expect(put.status).toBe(200);

  await service!.shutdown();
  service = null;
  writeConfig({ preRollMs: 9000, detector: { chat: { minSpike: 2, minTriggerShare: 0.7 } } });
  base = await start();
  cookie = await login(base);
  const [again] = await list();
  expect(again).toMatchObject({ id: first!.id, settings: { cut: { preRollMs: 3000 }, detector: { chat: { minTriggerShare: 0.6 } } } });
});

it('runs and stops with Google Drive never configured, reporting it as not connected', async () => {
  writeConfig({});
  const base = await start();
  const cookie = await login(base);
  const drive = (await (await get(base, cookie, '/api/drive')).json()) as any;
  expect(drive).toMatchObject({ hasCredentials: false, connected: false, folder: null, sync: { running: false, pending: 0 } });
  const sync = await fetch(`${base}/api/drive/sync`, { method: 'POST', headers: { Cookie: cookie } });
  expect(sync.status).toBe(409);
  await service!.shutdown();
  service = null;
});
