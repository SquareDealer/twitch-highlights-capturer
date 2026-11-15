import { vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureSession, Segment } from '@shared/types';
import { RingBufferManager } from '../../src/main/capture/ringBuffer';
import { openDb } from '../../src/main/db';
import { createClipRepo } from '../../src/service/clipRepo';
import { defaultConfig, type ServiceConfig } from '../../src/service/config';
import { Cutter } from '../../src/service/cutter';
import type { DetectorEvent, FeedClip } from '../../src/service/types';
import { hasFfmpeg, probeDurationSec, synthVideo, tmpDir } from '../helpers';

let ring: RingBufferManager;
let clips: ReturnType<typeof createClipRepo>;
let cfg: ServiceConfig;
let session: CaptureSession;
let concatCalls: { segs: string[]; out: string }[];
let concatError = 'ffmpeg упал';
let concatFail: number; // number of upcoming concat calls that fail
let cutter: Cutter;
let free: number;
let paused: boolean;
let sleeps: number[];
let nextId: number;
const NOW = new Date(2026, 10, 15, 12, 0, 0);

const seg = (epoch: number, seq: number, dir = '/b'): Segment => ({
  sessionId: 's1', epoch, seq, path: `${dir}/e${epoch}/seg_${seq}.ts`, startMs: seq * 2000, endMs: seq * 2000 + 2000, bytes: 100, completedAtWallMs: 0,
});
const fill = (epoch: number, from: number, to: number) => {
  for (let i = from; i < to; i++) ring.add(seg(epoch, i));
};

const event = (over: Partial<DetectorEvent> = {}): DetectorEvent => ({
  epoch: 1, startMs: 100_000, endMs: 110_000, triggerTimeMs: 105_000, estimatedEventMs: 102_000, uncertaintyMs: 1000,
  triggers: ['laugh'], confidence: 'normal', scores: { S: 0.7, C: 0.5, E: 0.5, U: 0.5, A: 0.5 },
  signals: { chatSpike: 4, laughShare: 0.5, reactionShare: 0.1, deltaDb: 3 }, ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('timeout');
}
/** Range of the segments handed to the last concat call, in seconds. */
const lastRange = () => {
  const nums = concatCalls.at(-1)!.segs.map((p) => Number(/seg_(\d+)/.exec(p)![1]));
  return [Math.min(...nums) * 2, Math.max(...nums) * 2 + 2];
};

function build(over: Partial<ServiceConfig> = {}, tailTimeoutMs = 200) {
  cfg = { ...defaultConfig(tmpDir()), ...over };
  cutter = new Cutter({
    ring, clips, config: () => cfg, session: () => session,
    concat: async (segs, out) => {
      concatCalls.push({ segs, out });
      if (concatFail > 0) {
        concatFail--;
        writeFileSync(out, 'partial');
        throw new Error(concatError);
      }
      writeFileSync(out, segs.join('\n'));
    },
    freeBytes: async () => free, paused: () => paused, now: () => NOW,
    newId: () => `id-${String(++nextId).padStart(4, '0')}`,
    sleep: async (ms) => void sleeps.push(ms), tailTimeoutMs,
  });
}

beforeEach(() => {
  ring = new RingBufferManager({
    segments: { insert: () => {}, remove: () => {}, clear: () => {} }, retentionMs: 300_000, maxPinnedBytes: 1e9,
    now: () => 0, unlink: async () => {},
  });
  clips = createClipRepo(openDb(':memory:'));
  session = { id: 's1', streamer: 'alice', streamId: '42', state: 'RECORDING', startedAt: NOW.toISOString(), epoch: 1 };
  concatCalls = [];
  concatFail = 0;
  concatError = 'ffmpeg упал';
  free = 1e12;
  paused = false;
  sleeps = [];
  nextId = 0;
  build();
});

const only = (): FeedClip => {
  const l = clips.list();
  expect(l).toHaveLength(1);
  return l[0]!;
};

test('cuts [start−15s, end+10s] after the tail segments arrive', async () => {
  fill(1, 0, 50); // buffer ends at 100 s
  const p = cutter.onEvent(event());
  await until(() => clips.list().length === 1);
  expect(only().status).toBe('pending');
  expect(ring.pinnedBytes()).toBeGreaterThan(0);
  fill(1, 50, 70);
  await p;
  expect(lastRange()).toEqual([84, 120]);
  const c = only();
  expect(c.status).toBe('new');
  // the requested range starts at 85 s, mid-segment: the clip describes the footage actually cut (84–120 s)
  expect([c.startMs, c.endMs, c.durationMs, c.score]).toEqual([84_000, 120_000, 36_000, 0.7]);
  const j = JSON.parse(readFileSync(c.jsonPath, 'utf8'));
  expect([j.startMs, j.endMs, j.durationMs]).toEqual([84_000, 120_000, 36_000]);
  expect(existsSync(c.mp4Path)).toBe(true);
  expect(c.bytes).toBeGreaterThan(0);
});

test('uses the 30 s pre-roll for a low-confidence chat event', async () => {
  fill(1, 0, 70);
  await cutter.onEvent(event({ confidence: 'low', triggers: ['laugh'] }));
  expect(only().startMs).toBe(70_000);
});

test('keeps 15 s for a low-confidence audio-only event', async () => {
  fill(1, 0, 70);
  await cutter.onEvent(event({ confidence: 'low', triggers: ['audio'] }));
  expect(lastRange()[0]).toBe(84); // 85 s requested, cut from the segment that contains it
  expect(only().startMs).toBe(84_000);
});

test('caps the clip at maxClipMs', async () => {
  fill(1, 0, 150);
  await cutter.onEvent(event({ startMs: 100_000, endMs: 190_000 }));
  const c = only();
  expect(lastRange()).toEqual([84, 176]); // requested 85–175 s
  expect([c.startMs, c.endMs]).toEqual([84_000, 176_000]);
});

test('writes clip.json next to the mp4 with event fields and configVersion', async () => {
  fill(1, 0, 70);
  const ev = event();
  await cutter.onEvent(ev);
  const c = only();
  expect(c.jsonPath.replace(/\.json$/, '')).toBe(c.mp4Path.replace(/\.mp4$/, ''));
  const j = JSON.parse(readFileSync(c.jsonPath, 'utf8'));
  expect(j).toMatchObject({ id: c.id, status: 'new', triggers: ['laugh'], score: 0.7, signals: ev.signals, event: ev });
  expect(j.configVersion).toBe(createHash('sha1').update(JSON.stringify(cfg.detector)).digest('hex'));
});

test('unpins the range after success and after failure', async () => {
  fill(1, 0, 70);
  await cutter.onEvent(event());
  expect(ring.pinnedBytes()).toBe(0);
  concatFail = 3;
  await cutter.onEvent(event());
  expect(ring.pinnedBytes()).toBe(0);
});

test('retries concat 3 times, then marks the clip as error and removes the .part file', async () => {
  fill(1, 0, 70);
  concatFail = 3;
  await cutter.onEvent(event());
  expect(concatCalls).toHaveLength(3);
  expect(sleeps).toEqual([1000, 1000]);
  const c = only();
  expect(c).toMatchObject({ status: 'error', error: 'ffmpeg упал' });
  expect(existsSync(`${c.mp4Path}.part`)).toBe(false);
  expect(existsSync(c.mp4Path)).toBe(false);
});

test('emits paused when concat fails because the disk is full', async () => {
  fill(1, 0, 70);
  const reasons: string[] = [];
  cutter.on('paused', (p: { reason: string }) => reasons.push(p.reason));
  concatFail = 3;
  concatError = 'write failed: No space left on device';
  await cutter.onEvent(event());
  const c = only();
  expect(c.status).toBe('error');
  expect(existsSync(`${c.mp4Path}.part`)).toBe(false);
  expect(reasons).toEqual(['Мало свободного места на диске']);
});

test('emits paused after a failed cut when free space dropped below the reserve', async () => {
  fill(1, 0, 70);
  const reasons: string[] = [];
  cutter.on('paused', (p: { reason: string }) => reasons.push(p.reason));
  concatFail = 3;
  const probe = vi.fn().mockResolvedValueOnce(1e12).mockResolvedValue(0);
  cutter = new Cutter({ ring, clips, config: () => cfg, session: () => session, concat: async (_s, out) => { writeFileSync(out, 'x'); throw new Error('ffmpeg упал'); }, freeBytes: probe, now: () => NOW, sleep: async () => {}, tailTimeoutMs: 50 });
  cutter.on('paused', (p: { reason: string }) => reasons.push(p.reason));
  await cutter.onEvent(event());
  expect(only().status).toBe('error');
  expect(reasons).toEqual(['Мало свободного места на диске']);
});

test('manual clips do not count toward the hourly limiter', async () => {
  fill(1, 0, 70);
  cfg.maxClipsPerHour = 2;
  for (let i = 0; i < 5; i++) expect((await cutter.manual()).ok).toBe(true);
  await cutter.onEvent(event({ scores: { S: 0.1, C: 0, E: 0, U: 0, A: 0 } }));
  await cutter.onEvent(event({ scores: { S: 0.2, C: 0, E: 0, U: 0, A: 0 } }));
  expect(clips.list().filter((c) => c.triggers[0] === 'laugh')).toHaveLength(2);
  await cutter.onEvent(event({ scores: { S: 0.05, C: 0, E: 0, U: 0, A: 0 } })); // over limit, below median
  expect(clips.list()).toHaveLength(7);
});

test('succeeds when a later concat attempt works', async () => {
  fill(1, 0, 70);
  concatFail = 2;
  await cutter.onEvent(event());
  expect(concatCalls).toHaveLength(3);
  expect(only().status).toBe('new');
});

test('marks the clip as error when the epoch has no segments left', async () => {
  fill(2, 0, 70);
  await cutter.onEvent(event({ epoch: 0 }));
  expect(only().status).toBe('error');
  expect(concatCalls).toHaveLength(0);
  expect(ring.pinnedBytes()).toBe(0);
});

test('cuts what exists when the event starts before the oldest segment', async () => {
  for (let i = 30; i < 70; i++) ring.add(seg(1, i)); // oldest segment starts at 60 s
  await cutter.onEvent(event({ startMs: 62_000, endMs: 70_000 }));
  expect(lastRange()).toEqual([60, 80]);
  expect(only().status).toBe('new');
});

test('drops events over the hourly limit unless the score beats the median', async () => {
  fill(1, 0, 70);
  cfg.maxClipsPerHour = 3;
  for (const s of [0.2, 0.5, 0.9]) {
    await cutter.onEvent(event({ scores: { S: s, C: 0, E: 0, U: 0, A: 0 } }));
  }
  expect(clips.list()).toHaveLength(3);
  await cutter.onEvent(event({ scores: { S: 0.5, C: 0, E: 0, U: 0, A: 0 } })); // == median
  expect(clips.list()).toHaveLength(3);
  await cutter.onEvent(event({ scores: { S: 0.6, C: 0, E: 0, U: 0, A: 0 } })); // > median
  expect(clips.list()).toHaveLength(4);
  const m = await cutter.manual();
  expect(m.ok).toBe(true);
  expect(clips.list()).toHaveLength(5);
});

test('drops events and emits paused when free space is below the reserve', async () => {
  fill(1, 0, 70);
  const reasons: string[] = [];
  cutter.on('paused', (p: { reason: string }) => reasons.push(p.reason));
  free = cfg.diskReserveBytes - 1;
  await cutter.onEvent(event());
  expect(clips.list()).toHaveLength(0);
  expect(reasons).toHaveLength(1);
  free = 1e12;
  paused = true;
  await cutter.onEvent(event());
  expect(clips.list()).toHaveLength(0);
  expect(reasons).toHaveLength(2);
});

test('emits clip on every status change', async () => {
  fill(1, 0, 70);
  const seen: string[] = [];
  cutter.on('clip', (c: FeedClip) => seen.push(c.status));
  await cutter.onEvent(event());
  expect(seen).toEqual(['pending', 'new']);
});

test('times out waiting for the tail and cuts what exists', async () => {
  fill(1, 0, 55); // buffer ends at 110 s, tail up to 120 s never arrives
  await cutter.onEvent(event());
  expect(lastRange()).toEqual([84, 110]);
  expect(only().status).toBe('new');
});

test('flush() cuts pending clips with the tail that exists', async () => {
  build({}, 60_000);
  fill(1, 0, 55);
  const p = cutter.onEvent(event());
  await until(() => clips.list().length === 1);
  await cutter.flush();
  await p;
  expect(only().status).toBe('new');
  expect(lastRange()).toEqual([84, 110]);
});

test('manual() cuts the last 60 s of the current epoch', async () => {
  fill(1, 0, 100); // 200 s
  const r = await cutter.manual();
  expect(r.ok).toBe(true);
  expect(lastRange()).toEqual([140, 200]);
  const c = only();
  expect([c.triggers, c.score, c.status, c.startMs, c.endMs]).toEqual([['manual'], 0, 'new', 140_000, 200_000]);
  expect(r.ok && r.value.id).toBe(c.id);
});

test('manual() falls back to the latest epoch with segments when the current one is empty', async () => {
  fill(1, 0, 100);
  session = { ...session, epoch: 2 }; // reconnected, no segment of epoch 2 yet
  const r = await cutter.manual();
  expect(r.ok).toBe(true);
  const c = only();
  expect([c.epoch, c.startMs, c.endMs]).toEqual([1, 140_000, 200_000]);
});

test("emits 'paused' only when the pause state changes", async () => {
  fill(1, 0, 70);
  const reasons: string[] = [];
  cutter.on('paused', (p: { reason: string }) => reasons.push(p.reason));
  paused = true;
  await cutter.onEvent(event());
  await cutter.onEvent(event());
  await cutter.manual();
  expect(reasons).toEqual(['Нарезка приостановлена']);
  paused = false;
  await cutter.onEvent(event());
  paused = true;
  await cutter.onEvent(event());
  expect(reasons).toEqual(['Нарезка приостановлена', 'Нарезка приостановлена']);
});

test('flush() waits for an event that arrived in the same tick, without waiting for its tail', async () => {
  build({}, 60_000);
  fill(1, 0, 55); // tail up to 120 s never arrives
  void cutter.onEvent(event());
  await cutter.flush();
  expect(only().status).toBe('new');
  expect(lastRange()).toEqual([84, 110]);
});

test('an event arriving after flush() is cut at once from what exists', async () => {
  build({}, 60_000);
  fill(1, 0, 55);
  await cutter.flush();
  await cutter.onEvent(event()); // would hang for 60 s if it waited for the tail
  expect(only().status).toBe('new');
  expect(lastRange()).toEqual([84, 110]);
});

test('manual() reports an error when the buffer is empty', async () => {
  const r = await cutter.manual();
  expect(r.ok).toBe(false);
});

test.skipIf(!hasFfmpeg)('produces a playable mp4 from real ts segments without re-encoding', async () => {
  const dir = tmpDir();
  synthVideo(20, ['-f', 'segment', '-segment_time', '2', '-reset_timestamps', '1', join(dir, 'seg_%d.ts')]);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
  expect(files.length).toBeGreaterThanOrEqual(9);
  files.forEach((f, i) => ring.add({ ...seg(1, i), path: join(dir, f) }));
  const { concatSegments } = await import('../../src/main/capture/concat');
  cfg = { ...defaultConfig(tmpDir()), preRollMs: 2000, postRollMs: 2000 };
  cutter = new Cutter({
    ring, clips, config: () => cfg, session: () => session, concat: concatSegments('ffmpeg'), freeBytes: async () => 1e12, now: () => NOW,
  });
  await cutter.onEvent(event({ startMs: 6000, endMs: 10_000 }));
  const c = only();
  expect(c.status).toBe('new');
  const codec = (f: string) =>
    String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f]).stdout).trim();
  expect(codec(c.mp4Path)).toBe('h264');
  expect(Math.abs(probeDurationSec(c.mp4Path) - 8)).toBeLessThanOrEqual(2.5);
});
