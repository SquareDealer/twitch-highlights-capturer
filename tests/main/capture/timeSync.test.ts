import { TimeSynchronizer } from '../../../src/main/capture/timeSync';

let cfg = { captureLatencyMs: 3000, defaultEmbedLatencyMs: 4000, markerOffsetMs: 0 };
let now = 1_010_000;
let ts: TimeSynchronizer;

beforeEach(() => {
  cfg = { captureLatencyMs: 3000, defaultEmbedLatencyMs: 4000, markerOffsetMs: 0 };
  now = 1_010_000;
  ts = new TimeSynchronizer(() => cfg, () => now);
  ts.onSegment({ epoch: 0, endMs: 2000, completedAtWallMs: 1_002_600 });
  ts.onSegment({ epoch: 0, endMs: 4000, completedAtWallMs: 1_004_100 }); // min offset = 1_000_100
});

test('captureNow: offset = min(completedAtWallMs − endMs) по эпохе', () => {
  expect(ts.captureNow(1_010_100)).toEqual({ epoch: 0, sourceTimeMs: 10_000 });
});

test('markerTime вычитает (embedLatency − captureLatency)', () => {
  ts.reportEmbedLatency(5000);
  expect(ts.markerTime(1_010_100)).toEqual({ epoch: 0, sourceTimeMs: 8_000 });
});

test.each([null, NaN, -1, 120_000])('задержка Embed %p → используется дефолт 4000', (v) => {
  ts.reportEmbedLatency(v as number);
  expect(ts.markerTime(1_010_100)!.sourceTimeMs).toBe(9_000);
});

test('значение задержки старше 10 с считается отсутствующим', () => {
  ts.reportEmbedLatency(5000);
  now += 10_001;
  expect(ts.markerTime(1_010_100)!.sourceTimeMs).toBe(9_000);
});

test('Embed быстрее захвата (latency 1000) → время впереди captureNow, без отсечения', () => {
  ts.reportEmbedLatency(1000);
  expect(ts.markerTime(1_010_100)!.sourceTimeMs).toBe(12_000);
});

test('результат не бывает отрицательным', () => {
  ts.reportEmbedLatency(30_000);
  expect(ts.markerTime(1_000_600)).toEqual({ epoch: 0, sourceTimeMs: 0 });
});

test('markerOffsetMs прибавляется, результат — целое', () => {
  cfg.markerOffsetMs = -1500;
  ts.reportEmbedLatency(5000.4);
  expect(ts.markerTime(1_010_100)!.sourceTimeMs).toBe(6_500);
});

test('новая эпоха использует только свои сегменты', () => {
  ts.onSegment({ epoch: 1, endMs: 2000, completedAtWallMs: 2_002_500 });
  expect(ts.captureNow(2_003_500)).toEqual({ epoch: 1, sourceTimeMs: 3_000 });
});

test('до первого сегмента captureNow и markerTime возвращают null', () => {
  const fresh = new TimeSynchronizer(() => cfg, () => now);
  expect(fresh.captureNow(1)).toBeNull();
  expect(fresh.markerTime(1)).toBeNull();
  ts.reset();
  expect(ts.captureNow(1_010_100)).toBeNull();
});
