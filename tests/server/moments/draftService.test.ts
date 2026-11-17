import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaptureSessionManager } from '../../../src/server/capture/sessionManager';
import { concatSegments, DraftService } from '../../../src/server/moments/draftService';
import { hasFfmpeg, probeDurationSec, synthVideo, tmpDir } from '../../helpers';
import { makeWorld, WALL0, type World } from './fixtures';

let w: World;
let drafts: DraftService;
let draftsDir: string;
let sleeps: number;
let onSleep: () => void;
let concatError: Error | null;

beforeEach(() => {
  w = makeWorld();
  draftsDir = join(tmpDir(), 'drafts');
  sleeps = 0;
  onSleep = () => {};
  concatError = null;
  drafts = new DraftService({
    repos: w.repos, ring: w.ring, timeSync: w.timeSync, moments: w.moments, settings: w.settings, draftsDir,
    currentSession: () => w.session(),
    concat: async (segments, outFile) => {
      writeFileSync(outFile, segments.join('\n'));
      if (concatError) throw concatError;
    },
    sleep: async () => {
      sleeps++;
      onSleep();
    },
    now: () => w.clock.now,
    newId: w.newId,
  });
});

const startsOf = (file: string) => readFileSync(file, 'utf8').split('\n').map((p) => Number(/seg_(\d+)\.ts/.exec(p)![1]) * 2000);
/** Each simulated poll delivers one more 2-second segment. */
const keepRecording = () => {
  onSleep = () => {
    const end = w.ring.latest(0)!.endMs;
    w.feed(0, end, end + 2000);
  };
};

test('F8 берёт сегменты, пересекающие [T − 180 с, T + 5 с], и ждёт дозаписи 5 с', async () => {
  w.feed(0, 0, 400_000);
  keepRecording();
  const r = await drafts.captureReplay();
  if (!r.ok) throw new Error(r.error);
  expect(sleeps).toBe(3); // 400 → 406 s covers T + 5 s
  const starts = startsOf(r.value.filePath);
  expect(starts[0]).toBe(220_000); // T − 180 s
  expect(starts.at(-1)).toBe(404_000);
  expect(r.value).toMatchObject({ sessionId: 's1', epoch: 0, startMs: 220_000, endMs: 406_000, filePath: join(draftsDir, `${r.value.id}.mp4`) });
  expect(w.repos.drafts.get(r.value.id)).toEqual(r.value);
});

test('буфер короче 180 с → черновик из имеющегося', async () => {
  w.feed(0, 0, 20_000);
  keepRecording();
  const r = await drafts.captureReplay();
  expect(r.ok && [r.value.startMs, r.value.endMs]).toEqual([0, 26_000]);
});

test.each([
  ['нет сессии', (x: World) => { x.feed(0, 0, 20_000); x.setSession(null); }],
  ['RECORDING без сегментов', (_x: World) => {}],
  ['RECONNECTING без сегментов', (x: World) => x.setState('RECONNECTING')],
])('F8 при «%s» → ok:false, pin снят, файла нет', async (_n, arrange) => {
  arrange(w);
  expect(await drafts.captureReplay()).toEqual({ ok: false, error: 'Буфер пуст — нечего сохранять' });
  expect(existsSync(draftsDir) ? readdirSync(draftsDir) : []).toEqual([]);
  expect(w.ring.pinnedBytes()).toBe(0);
  expect(drafts.list()).toEqual([]);
});

test('дозапись не пришла за 15 с → черновик из того, что есть', async () => {
  w.feed(0, 0, 20_000);
  const r = await drafts.captureReplay();
  expect(sleeps).toBe(60);
  expect(r.ok && r.value.endMs).toBe(20_000);
});

test('два F8 подряд → два независимых черновика; draftId активного момента = последний', async () => {
  w.feed(0, 0, 20_000);
  keepRecording();
  const [a, b] = await Promise.all([drafts.captureReplay(), drafts.captureReplay()]);
  if (!a.ok || !b.ok) throw new Error('expected two drafts');
  expect(a.value.id).not.toBe(b.value.id);
  expect(drafts.list().map((d) => d.id).sort()).toEqual([a.value.id, b.value.id].sort());
  expect(existsSync(a.value.filePath) && existsSync(b.value.filePath)).toBe(true);
  const c = await drafts.captureReplay();
  expect(w.repos.moments.activeFor('s1')!.draftId).toBe(c.ok && c.value.id);
});

test('сегменты черновика не удаляются cleanup-ом, пока черновик жив', async () => {
  w.feed(0, 0, 20_000);
  keepRecording();
  const r = await drafts.captureReplay();
  if (!r.ok) throw new Error(r.error);
  expect(await w.survives(0, 10_000)).toBe(true);
  await drafts.discard(r.value.id);
  expect(await w.survives(0, 10_000)).toBe(false);
});

test('ошибка concat → ok:false, pin снят, частичный файл удалён', async () => {
  w.feed(0, 0, 20_000);
  keepRecording();
  concatError = new Error('ffmpeg failed');
  const r = await drafts.captureReplay();
  expect(r).toEqual({ ok: false, error: 'Не удалось собрать черновик: ffmpeg failed' });
  expect(readdirSync(draftsDir)).toEqual([]);
  expect(w.ring.pinnedBytes()).toBe(0);
  expect(w.repos.moments.activeFor('s1')?.draftId ?? null).toBeNull();
});

test('createFromMarkers: один черновик на группу близких маркеров, диапазон [min − 30 с, max + 60 с]; без маркеров — ничего', async () => {
  w.feed(0, 0, 300_000);
  expect(await drafts.createFromMarkers('s1')).toEqual([]);
  w.moments.addMarker(1, WALL0 + 100_000);
  w.moments.addMarker(2, WALL0 + 150_000);
  const [d, ...rest] = await drafts.createFromMarkers('s1');
  expect(rest).toEqual([]);
  expect([d!.epoch, d!.startMs, d!.endMs]).toEqual([0, 70_000, 210_000]);
  expect(w.repos.moments.activeFor('s1')!.draftId).toBe(d!.id);
  expect(await drafts.createFromMarkers('s1')).toEqual([]); // everything is covered now
  expect(sleeps).toBe(0);
});

test('createFromMarkers спасает маркер, поставленный после F8 за пределами уже существующего черновика', async () => {
  w.feed(0, 0, 20_000);
  keepRecording();
  const first = await drafts.captureReplay();
  if (!first.ok) throw new Error(first.error);
  onSleep = () => {};
  w.feed(0, 26_000, 400_000);
  const inside = w.moments.addMarker(1, WALL0 + 10_000);
  const later = w.moments.addMarker(2, WALL0 + 300_000);
  if (!inside.ok || !later.ok) throw new Error('markers expected');
  const built = await drafts.createFromMarkers('s1');
  expect(built.map((d) => [d.epoch, d.startMs, d.endMs])).toEqual([[0, 270_000, 360_000]]);
  expect(drafts.list()).toHaveLength(2);
});

test('createFromMarkers: маркеры из разных эпох и далеко друг от друга → отдельные черновики без разрывов внутри', async () => {
  w.feed(0, 0, 100_000);
  w.moments.addMarker(1, WALL0 + 50_000);
  w.feed(1, 0, 40_000);
  w.moments.addMarker(2, WALL0 + 10_000);
  w.feed(1, 40_000, 1_000_000);
  w.moments.addMarker(3, WALL0 + 900_000);
  await w.survives(1, 500_000); // the unpinned middle of epoch 1 is gone by now
  const built = await drafts.createFromMarkers('s1');
  expect(built.map((d) => [d.epoch, d.startMs, d.endMs])).toEqual([
    [0, 20_000, 100_000],
    [1, 0, 70_000],
    [1, 870_000, 960_000],
  ]);
});

test('F8 при переподключении: буфер цел → черновик из последних 180 с того, что записано, без ожидания', async () => {
  w.feed(0, 0, 400_000);
  w.setSession({ state: 'RECONNECTING', epoch: 1 });
  const r = await drafts.captureReplay();
  expect(r.ok && [r.value.epoch, r.value.startMs, r.value.endMs]).toEqual([0, 220_000, 400_000]);
  expect(sleeps).toBe(0);
});

test('остановка записи во время дозаписи F8 не теряет повтор; whenIdle дожидается сборки', async () => {
  w.feed(0, 0, 20_000);
  onSleep = () => w.setState('STOPPING');
  const pending = drafts.captureReplay();
  let idle = false;
  void drafts.whenIdle().then(() => (idle = true));
  await Promise.resolve();
  expect(idle).toBe(false);
  const r = await pending;
  expect(sleeps).toBe(1);
  expect(r.ok && [r.value.startMs, r.value.endMs]).toEqual([0, 20_000]);
  await drafts.whenIdle();
  await vi.waitFor(() => expect(idle).toBe(true));
});

test('extend расширяет диапазон, пока сегменты есть; без сегментов возвращает прежний черновик', async () => {
  w.feed(0, 0, 400_000);
  keepRecording();
  const r = await drafts.captureReplay();
  if (!r.ok) throw new Error(r.error);
  onSleep = () => {};
  const wider = await drafts.extend(r.value.id, { beforeMs: 30_000, afterMs: 0 });
  expect([wider.startMs, wider.endMs]).toEqual([190_000, 406_000]);
  expect(startsOf(wider.filePath)[0]).toBe(190_000);
  expect(w.repos.drafts.get(r.value.id)).toEqual(wider);
  expect(readdirSync(draftsDir)).toEqual([`${r.value.id}.mp4`]);
  const same = await drafts.extend(r.value.id, { beforeMs: 0, afterMs: 30_000 }); // nothing recorded after 406 s
  expect(same).toEqual(wider);
  await w.ring.clearAll(); // session stopped
  expect(await drafts.extend(r.value.id, { beforeMs: 30_000, afterMs: 30_000 })).toEqual(wider);
  await expect(drafts.extend('missing', { beforeMs: 1, afterMs: 1 })).rejects.toThrow('Черновик не найден');
});

test('discard удаляет файл, запись и pin, обнуляет draftId момента', async () => {
  w.feed(0, 0, 20_000);
  keepRecording();
  const r = await drafts.captureReplay();
  if (!r.ok) throw new Error(r.error);
  const events: unknown[] = [];
  drafts.on('changed', () => events.push(1));
  await drafts.discard(r.value.id);
  expect(existsSync(r.value.filePath)).toBe(false);
  expect(drafts.list()).toEqual([]);
  expect(w.repos.moments.activeFor('s1')!.draftId).toBeNull();
  expect(w.ring.pinnedBytes()).toBe(0);
  expect(events).toHaveLength(1);
  await expect(drafts.discard(r.value.id)).resolves.toBeUndefined();
});

test('CaptureSessionManager.captureReplay делегирует в replay и возвращает id черновика', async () => {
  const base = { runner: {} as never, ring: w.ring, timeSync: w.timeSync, sessions: w.repos.sessions, settings: w.settings };
  const manager = new CaptureSessionManager({
    ...base,
    replay: async () => {
      const r = await drafts.captureReplay();
      if (!r.ok) throw new Error(r.error);
      return r.value.id;
    },
  });
  await expect(manager.captureReplay()).rejects.toThrow('Буфер пуст — нечего сохранять');
  w.feed(0, 0, 20_000);
  keepRecording();
  expect(await manager.captureReplay()).toBe(drafts.list()[0]!.id);
  await expect(new CaptureSessionManager(base).captureReplay()).rejects.toThrow('Повтор недоступен');
});

describe.skipIf(!hasFfmpeg)('concatSegments', () => {
  test('склеивает реальные ts-сегменты в mp4 длительностью ≈ сумме (±0.5 с), в том числе по пути с пробелом и апострофом', async () => {
    const dir = join(tmpDir(), "it's a dir");
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    synthVideo(6, ['-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts', '-reset_timestamps', '0', join(dir, 'seg_%06d.ts')]);
    const segments = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => join(dir, f));
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const out = join(dir, 'draft out.mp4');
    await concatSegments('ffmpeg')(segments, out);
    expect(Math.abs(probeDurationSec(out) - 6)).toBeLessThan(0.5);
    expect(readdirSync(dir).filter((f) => !f.endsWith('.ts'))).toEqual(['draft out.mp4']);
    // a draft cut from the middle of the stream starts at ~0
    const tail = join(dir, 'tail.mp4');
    await concatSegments('ffmpeg')(segments.slice(1), tail);
    expect(Math.abs(probeDurationSec(tail) - 4)).toBeLessThan(0.5);
  });

  test('путь к ffmpeg, изменённый в настройках после запуска, действует сразу', async () => {
    const dir = tmpDir();
    synthVideo(4, ['-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts', '-reset_timestamps', '0', join(dir, 'seg_%06d.ts')]);
    w.settings.set({ ffmpegPath: join(dir, 'no-such-ffmpeg') });
    const real = new DraftService({
      repos: w.repos, ring: w.ring, timeSync: w.timeSync, moments: w.moments, settings: w.settings, draftsDir,
      currentSession: () => w.session(), sleep: async () => {}, now: () => w.clock.now, newId: w.newId,
    });
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    files.forEach((f, i) => {
      const seg = { sessionId: 's1', epoch: 0, seq: i, path: join(dir, f), startMs: i * 2000, endMs: i * 2000 + 2000, bytes: 1, completedAtWallMs: WALL0 + i * 2000 + 2000 };
      w.ring.add(seg);
      w.timeSync.onSegment(seg);
    });
    w.setState('RECONNECTING');
    expect((await real.captureReplay()).ok).toBe(false);
    w.settings.set({ ffmpegPath: 'ffmpeg' });
    const ok = await real.captureReplay();
    expect(ok.ok && probeDurationSec(ok.value.filePath)).toBeGreaterThan(3);
  });

  test('ошибка ffmpeg отклоняет промис', async () => {
    await expect(concatSegments('ffmpeg')([join(tmpDir(), 'missing.ts')], join(tmpDir(), 'o.mp4'))).rejects.toThrow();
  });
});
