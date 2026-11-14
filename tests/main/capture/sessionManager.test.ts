import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureSession, CaptureState, Segment } from '@shared/types';
import { openDb } from '../../../src/main/db';
import { createRepos, type Repos } from '../../../src/main/db/repos';
import type { CaptureProcs, ProcessRunner } from '../../../src/main/capture/processes';
import { RingBufferManager } from '../../../src/main/capture/ringBuffer';
import { CaptureSessionManager } from '../../../src/main/capture/sessionManager';
import { TimeSynchronizer } from '../../../src/main/capture/timeSync';
import { defaultSettings, SettingsStore } from '../../../src/main/settings';
import { tmpDir } from '../../helpers';

class FakeRunner implements ProcessRunner {
  probes: Array<{ live: true; streamId: string } | { live: false; reason: string }> = [];
  binariesError: string | null = null;
  probeCalls = 0;
  spawned: Array<{ channel: string; epochDir: string; exit: (reason: string) => void; stopped: boolean }> = [];
  log: string[] = [];

  async probe() {
    this.probeCalls++;
    return this.probes.shift() ?? { live: true as const, streamId: '987654321' };
  }
  async checkBinaries() {
    return this.binariesError;
  }
  spawnCapture(channel: string, epochDir: string): CaptureProcs {
    let cb: (reason: string) => void = () => {};
    const entry = { channel, epochDir, exit: (reason: string) => cb(reason), stopped: false };
    this.spawned.push(entry);
    return {
      onExit: (f) => void (cb = f),
      stop: async () => {
        entry.stopped = true;
        this.log.push('procs.stop');
      },
    };
  }
  get running() {
    return this.spawned.filter((s) => !s.stopped).length;
  }
}

let runner: FakeRunner;
let repos: Repos;
let ring: RingBufferManager;
let timeSync: TimeSynchronizer;
let manager: CaptureSessionManager;
let states: Array<CaptureState | null>;
let sleeps: number[];
let sleepGate: Promise<void> | null;
let bufferDir: string;

function build(extra: { beforeStop?: (s: CaptureSession) => Promise<void> } = {}) {
  manager = new CaptureSessionManager({
    runner, ring, timeSync, sessions: repos.sessions,
    settings: new SettingsStore(repos.db, { ...defaultSettings({ videos: bufferDir, userData: bufferDir }), bufferDir }),
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleepGate) await sleepGate;
    },
    pollMs: 5,
    ...extra,
  });
  manager.on('state', (s: CaptureSession | null) => states.push(s ? s.state : null));
}

beforeEach(() => {
  bufferDir = tmpDir();
  runner = new FakeRunner();
  repos = createRepos(openDb(':memory:'));
  ring = new RingBufferManager({ segments: repos.segments, retentionMs: 300_000, maxPinnedBytes: 1e12 });
  timeSync = new TimeSynchronizer(() => ({ captureLatencyMs: 3000, defaultEmbedLatencyMs: 4000, markerOffsetMs: 0 }));
  states = [];
  sleeps = [];
  sleepGate = null;
  build();
});
afterEach(async () => {
  await manager.stop();
});

/** Simulates FFmpeg finishing a segment in the given epoch directory. */
function feed(epochDir: string, seq: number, startSec: number, endSec: number) {
  mkdirSync(epochDir, { recursive: true });
  const file = `seg_${String(seq).padStart(6, '0')}.ts`;
  writeFileSync(join(epochDir, file), 'x'.repeat(10));
  appendFileSync(join(epochDir, 'segments.csv'), `${file},${startSec.toFixed(6)},${endSec.toFixed(6)}\n`);
}
const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 3000, interval: 5 });

test('start: CONNECTING → RECORDING после первого сегмента; streamId из probe', async () => {
  await manager.start('Foo_Bar');
  expect(manager.current()).toMatchObject({ streamer: 'foo_bar', streamId: '987654321', state: 'CONNECTING', epoch: 0 });
  expect(runner.spawned[0]!.epochDir).toBe(join(bufferDir, manager.current()!.id, 'e0'));
  feed(runner.spawned[0]!.epochDir, 0, 1234.5, 1236.5);
  await until(() => manager.current()!.state === 'RECORDING');
  expect(states).toEqual(['CONNECTING', 'RECORDING']);
  expect(repos.sessions.get(manager.current()!.id)).toMatchObject({ state: 'RECORDING', streamId: '987654321' });
  const seg = ring.latest(0) as Segment;
  expect(seg).toMatchObject({ seq: 0, startMs: 0, endMs: 2000, bytes: 10, epoch: 0 });
  expect(timeSync.captureNow(Date.now())).not.toBeNull();
});

test('канал не в эфире → ERROR с сообщением, процессы не запускаются', async () => {
  runner.probes = [{ live: false, reason: 'No playable streams' }];
  await manager.start('foo');
  expect(manager.current()).toMatchObject({ state: 'ERROR', error: 'Канал не в эфире' });
  expect(runner.spawned).toHaveLength(0);
});

test('нет бинарников → ERROR с текстом checkBinaries', async () => {
  runner.binariesError = 'Не найден streamlink';
  await manager.start('foo');
  expect(manager.current()).toMatchObject({ state: 'ERROR', error: 'Не найден streamlink' });
  expect(runner.probeCalls).toBe(0);
});

test('некорректное имя канала → ERROR, probe не вызывается', async () => {
  await manager.start('a b');
  expect(manager.current()).toMatchObject({ state: 'ERROR', error: 'Некорректное имя канала' });
  expect(runner.probeCalls).toBe(0);
});

test('выход процесса → RECONNECTING, новая эпоха, после нового сегмента снова RECORDING', async () => {
  await manager.start('foo');
  feed(runner.spawned[0]!.epochDir, 0, 10, 12);
  await until(() => manager.current()!.state === 'RECORDING');
  runner.spawned[0]!.exit('streamlink exited');
  await until(() => runner.spawned.length === 2);
  expect(manager.current()).toMatchObject({ state: 'RECONNECTING', epoch: 1 });
  feed(runner.spawned[1]!.epochDir, 0, 500, 502.1);
  await until(() => manager.current()!.state === 'RECORDING');
  expect(states).toEqual(['CONNECTING', 'RECORDING', 'RECONNECTING', 'RECORDING']);
});

test('сегменты новой эпохи начинаются с startMs = 0 и лежат в отдельном каталоге; старые сохраняются', async () => {
  await manager.start('foo');
  feed(runner.spawned[0]!.epochDir, 0, 10, 12);
  await until(() => ring.latest(0) !== null);
  runner.spawned[0]!.exit('boom');
  await until(() => runner.spawned.length === 2);
  expect(runner.spawned[1]!.epochDir).toBe(join(bufferDir, manager.current()!.id, 'e1'));
  feed(runner.spawned[1]!.epochDir, 0, 500, 502.1);
  feed(runner.spawned[1]!.epochDir, 1, 502.1, 504);
  await until(() => ring.latest(1)?.seq === 1);
  expect(ring.select(1, 0, 1e9).map((s) => [s.startMs, s.endMs])).toEqual([[0, 2100], [2100, 4000]]);
  expect(ring.latest(0)).not.toBeNull();
  expect(existsSync(ring.latest(0)!.path)).toBe(true);
});

test('сегмент, дописанный прямо перед выходом процесса, не теряется', async () => {
  await manager.start('foo');
  feed(runner.spawned[0]!.epochDir, 0, 0, 2);
  await until(() => ring.latest(0) !== null);
  feed(runner.spawned[0]!.epochDir, 1, 2, 4);
  runner.spawned[0]!.exit('eof');
  expect(ring.latest(0)!.seq).toBe(1);
});

test('паузы повторов 2, 5, 10, 30, 30 секунд', async () => {
  await manager.start('foo');
  runner.probes = Array.from({ length: 4 }, () => ({ live: false as const, reason: 'offline' }));
  runner.spawned[0]!.exit('boom');
  await until(() => runner.spawned.length === 2);
  expect(sleeps).toEqual([2000, 5000, 10_000, 30_000, 30_000]);
  expect(manager.current()!.epoch).toBe(1);
});

test('stop во время RECONNECTING прекращает повторы и приводит к IDLE', async () => {
  await manager.start('foo');
  let release!: () => void;
  sleepGate = new Promise((r) => (release = r));
  runner.spawned[0]!.exit('boom');
  await until(() => manager.current()?.state === 'RECONNECTING');
  const id = manager.current()!.id;
  await manager.stop();
  expect(manager.current()).toBeNull();
  release();
  await new Promise((r) => setTimeout(r, 30));
  expect(runner.spawned).toHaveLength(1);
  expect(states.at(-1)).toBeNull();
  expect(repos.sessions.get(id)!.state).toBe('IDLE');
});

test('stop вызывает beforeStop до остановки процессов и до очистки буфера', async () => {
  build({
    beforeStop: async (s) => {
      runner.log.push(`beforeStop:${s.state}:segments=${ring.select(0, 0, 1e9).length}`);
    },
  });
  await manager.start('foo');
  const dir = runner.spawned[0]!.epochDir;
  feed(dir, 0, 0, 2);
  await until(() => ring.latest(0) !== null);
  await manager.stop();
  expect(runner.log).toEqual(['beforeStop:STOPPING:segments=1', 'procs.stop']);
  expect(ring.latest(0)).toBeNull();
  expect(existsSync(dir)).toBe(false);
  expect(timeSync.captureNow(Date.now())).toBeNull();
});

test('stop в IDLE и повторный stop — no-op', async () => {
  await manager.stop();
  await manager.start('foo');
  await Promise.all([manager.stop(), manager.stop()]);
  expect(manager.current()).toBeNull();
  expect(runner.log).toEqual(['procs.stop']);
});

test('start второго канала останавливает первый: одновременно не более одного spawnCapture', async () => {
  await manager.start('one');
  await manager.start('two');
  expect(runner.spawned.map((s) => s.channel)).toEqual(['one', 'two']);
  expect(runner.running).toBe(1);
  expect(manager.current()!.streamer).toBe('two');
});

test('reconnect() перезапускает захват немедленно в новой эпохе', async () => {
  await manager.start('foo');
  await manager.reconnect();
  expect(sleeps).toEqual([]);
  expect(runner.spawned).toHaveLength(2);
  expect(runner.spawned[0]!.stopped).toBe(true);
  expect(manager.current()).toMatchObject({ state: 'RECONNECTING', epoch: 1 });
});
