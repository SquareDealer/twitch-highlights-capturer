import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip, Draft } from '@shared/types';
import { encodeClip, Exporter, type ExportJob } from '../../../src/main/export/exporter';
import { DraftService } from '../../../src/main/moments/draftService';
import { hasFfmpeg, probeDurationSec, synthVideo, tmpDir } from '../../helpers';
import { makeWorld, WALL0, type World } from '../moments/fixtures';

let w: World;
let drafts: DraftService;
let exporter: Exporter;
let libraryDir: string;
let draftsDir: string;
let encodeError: Error | null;
let encodes: Array<{ startMs: number; durationMs: number }>;
let saved: Clip[];
let failed: Array<{ momentId: string; error: string }>;

beforeEach(() => {
  w = makeWorld();
  const root = tmpDir();
  libraryDir = join(root, 'library');
  draftsDir = join(root, 'drafts');
  w.settings.set({ libraryDir });
  w.repos.sessions.insert(w.session()!);
  encodeError = null;
  encodes = [];
  saved = [];
  failed = [];
  drafts = new DraftService({
    repos: w.repos, ring: w.ring, timeSync: w.timeSync, moments: w.moments, settings: w.settings, draftsDir,
    currentSession: () => w.session(), concat: async (_s, out) => writeFileSync(out, 'draft'), sleep: async () => {}, now: () => w.clock.now, newId: w.newId,
  });
  exporter = new Exporter({
    repos: w.repos, moments: w.moments, drafts, settings: w.settings,
    encode: async (a) => {
      encodes.push({ startMs: a.startMs, durationMs: a.durationMs });
      writeFileSync(a.output, 'partial');
      if (encodeError) throw encodeError;
    },
    now: () => new Date(2026, 10, 14, 19, 42, 10),
    newId: w.newId,
  });
  exporter.on('saved', (c: Clip) => saved.push(c));
  exporter.on('failed', (f: { momentId: string; error: string }) => failed.push(f));
});

/** Draft covering [100 s, 160 s] of epoch 0 with a real file on disk. */
function makeDraft(): Draft {
  w.feed(0, 0, 200_000);
  mkdirSync(draftsDir, { recursive: true });
  const d: Draft = { id: 'd1', sessionId: 's1', epoch: 0, startMs: 100_000, endMs: 160_000, filePath: join(draftsDir, 'd1.mp4'), createdAt: 'x' };
  writeFileSync(d.filePath, 'draft');
  w.repos.drafts.insert(d);
  w.ring.pin(d.id, 0, d.startMs, d.endMs);
  return d;
}
const mark = (type: 1 | 2 | 3, sourceMs: number, comment = '') => {
  const r = w.moments.addMarker(type, WALL0 + sourceMs);
  if (!r.ok) throw new Error(r.error);
  w.moments.setComment(r.value.id, comment);
  return r.value;
};
const request = (trimStartMs: number, trimEndMs: number, title = 'Funny reaction'): ExportJob => {
  const r = exporter.request({ draftId: 'd1', trimStartMs, trimEndMs, title });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
/** Mirrors the queue: handle, and on error report through onFailed. */
const runJob = async (job: ExportJob) => {
  try {
    await exporter.handle(job);
  } catch (e) {
    exporter.onFailed(job, (e as Error).message);
  }
};

test('успех: mp4 и markers.json на месте, .part нет, clip в БД, момент SAVED, черновик удалён', async () => {
  const d = makeDraft();
  mark(2, 130_000, 'смешно');
  const job = request(10_000, 50_000);
  expect(w.repos.moments.get(job.momentId)!.status).toBe('EXPORTING');
  await runJob(job);
  const clip = w.repos.clips.get(job.clipId)!;
  expect(clip).toMatchObject({ title: 'Funny reaction', durationMs: 40_000, syncStatus: 'pending', sessionId: 's1', momentId: job.momentId });
  expect(clip.mp4Path.replace(/\\/g, '/')).toMatch(/library\/foo\/987654321_\d{4}-\d\d-\d\d_\d\d-\d\d\/2026-11-14_19-42_funny-reaction_[0-9a-f]{4}\/funny-reaction\.mp4$/);
  expect(readdirSync(clip.dir).sort()).toEqual(['funny-reaction.mp4', 'markers.json']);
  expect(encodes).toEqual([{ startMs: 10_000, durationMs: 40_000 }]);
  expect(w.repos.moments.get(job.momentId)!.status).toBe('SAVED');
  expect(w.repos.drafts.get(d.id)).toBeNull();
  expect(existsSync(d.filePath)).toBe(false);
  expect(w.ring.pinnedBytes()).toBe(0);
  expect(saved).toEqual([clip]);
  expect(failed).toEqual([]);
});

test('markers.json: timeMs = sourceTimeMs − draft.startMs − trimStartMs; маркеры вне trim отсутствуют', async () => {
  makeDraft();
  const inTrim = mark(2, 130_000, 'смешно');
  mark(1, 105_000, 'до обрезки');
  mark(3, 155_000, 'после обрезки');
  const job = request(10_000, 50_000);
  await runJob(job);
  const json = JSON.parse(readFileSync(w.repos.clips.get(job.clipId)!.markersPath, 'utf8'));
  expect(json).toEqual({
    version: 1,
    clipId: job.clipId,
    title: 'Funny reaction',
    streamer: 'foo',
    streamId: '987654321',
    createdAt: new Date(2026, 10, 14, 19, 42, 10).toISOString(),
    durationMs: 40_000,
    sourceEpoch: 0,
    sourceStartMs: 110_000,
    markers: [{ id: inTrim.id, type: 2, timeMs: 20_000, comment: 'смешно' }],
  });
});

test('клип без маркеров сохраняется с "markers": []', async () => {
  makeDraft();
  const job = request(0, 60_000, '');
  await runJob(job);
  const clip = w.repos.clips.get(job.clipId)!;
  expect(JSON.parse(readFileSync(clip.markersPath, 'utf8')).markers).toEqual([]);
  expect(clip.mp4Path.endsWith('clip.mp4')).toBe(true);
});

test('ошибка encode: момент FAILED (через onFailed), черновик и маркеры целы, в папке клипа нет .part', async () => {
  const d = makeDraft();
  const m = mark(2, 130_000);
  encodeError = new Error('encoder crashed');
  const job = request(0, 60_000);
  await runJob(job);
  const moment = w.repos.moments.get(job.momentId)!;
  expect(moment.status).toBe('FAILED');
  expect(moment.markers.map((x) => x.id)).toEqual([m.id]);
  expect(existsSync(d.filePath)).toBe(true);
  expect(w.repos.clips.get(job.clipId)).toBeNull();
  const leftovers = existsSync(libraryDir) ? (readdirSync(libraryDir, { recursive: true }) as string[]).filter((f) => /\.(part|mp4|json)$/.test(f)) : [];
  expect(leftovers).toEqual([]);
  expect(failed).toEqual([{ momentId: job.momentId, error: 'encoder crashed' }]);
  // retry succeeds and reuses the same moment
  encodeError = null;
  const again = request(0, 60_000);
  expect(again.momentId).toBe(job.momentId);
  await runJob(again);
  expect(w.repos.moments.get(job.momentId)!.status).toBe('SAVED');
});

test('request: trim за пределами черновика приводится к границам; длительность < 500 мс → ok:false и момент остаётся ACTIVE', () => {
  makeDraft();
  mark(1, 130_000);
  const activeId = w.repos.moments.activeFor('s1')!.id;
  expect(exporter.request({ draftId: 'd1', trimStartMs: 10_000, trimEndMs: 10_400, title: 't' })).toEqual({ ok: false, error: 'Клип короче 0,5 секунды' });
  expect(exporter.request({ draftId: 'd1', trimStartMs: 50_000, trimEndMs: 20_000, title: 't' }).ok).toBe(false);
  expect(exporter.request({ draftId: 'd1', trimStartMs: NaN, trimEndMs: 20_000, title: 't' }).ok).toBe(false);
  expect(exporter.request({ draftId: 'nope', trimStartMs: 0, trimEndMs: 20_000, title: 't' })).toEqual({ ok: false, error: 'Черновик не найден' });
  expect(w.repos.moments.activeFor('s1')!.id).toBe(activeId);
  const ok = exporter.request({ draftId: 'd1', trimStartMs: -5_000, trimEndMs: 999_999, title: 't' });
  expect(ok.ok && [ok.value.trimStartMs, ok.value.trimEndMs]).toEqual([0, 60_000]);
});

test('request отклоняется, если файла черновика нет на диске', () => {
  const d = makeDraft();
  rmSync(d.filePath);
  expect(exporter.request({ draftId: 'd1', trimStartMs: 0, trimEndMs: 20_000, title: 't' })).toEqual({ ok: false, error: 'Файл черновика не найден' });
});

test('два клипа с одинаковым названием в одну минуту лежат в разных папках', async () => {
  makeDraft();
  const a = request(0, 60_000, 'Same');
  await runJob(a);
  const d2: Draft = { id: 'd2', sessionId: 's1', epoch: 0, startMs: 100_000, endMs: 160_000, filePath: join(draftsDir, 'd2.mp4'), createdAt: 'x' };
  writeFileSync(d2.filePath, 'draft');
  w.repos.drafts.insert(d2);
  const r = exporter.request({ draftId: 'd2', trimStartMs: 0, trimEndMs: 60_000, title: 'Same' });
  if (!r.ok) throw new Error(r.error);
  await runJob(r.value);
  const [c1, c2] = [w.repos.clips.get(a.clipId)!, w.repos.clips.get(r.value.clipId)!];
  expect(c1.dir).not.toBe(c2.dir);
  expect(existsSync(c1.mp4Path) && existsSync(c2.mp4Path)).toBe(true);
});

describe.skipIf(!hasFfmpeg)('encodeClip', () => {
  test('вырезает [2 с, 5 с] из 10-секундного mp4 → длительность 3 с ± 0.1', async () => {
    const dir = tmpDir();
    const input = join(dir, 'in.mp4');
    synthVideo(10, ['-f', 'mp4', input]);
    const output = join(dir, 'out.mp4.part');
    await encodeClip('ffmpeg')({ input, startMs: 2000, durationMs: 3000, output });
    expect(Math.abs(probeDurationSec(output) - 3)).toBeLessThan(0.1);
  });

  test('ошибка ffmpeg отклоняет промис', async () => {
    const dir = tmpDir();
    await expect(encodeClip('ffmpeg')({ input: join(dir, 'missing.mp4'), startMs: 0, durationMs: 1000, output: join(dir, 'o.part') })).rejects.toThrow();
  });
});
