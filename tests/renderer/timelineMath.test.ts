import { clampTrim, msToPx, pxToMs } from '../../src/renderer/src/timelineMath';

test('pxToMs/msToPx взаимно обратны в пределах 1 px', () => {
  for (const ms of [0, 1, 999, 61_234, 180_000]) {
    expect(Math.abs(msToPx(pxToMs(msToPx(ms, 800, 180_000), 800, 180_000), 800, 180_000) - msToPx(ms, 800, 180_000))).toBeLessThan(1);
  }
  expect(msToPx(90_000, 800, 180_000)).toBe(400);
  expect(pxToMs(400, 800, 180_000)).toBe(90_000);
});

test('pxToMs приводит к [0, durationMs] при px < 0 и px > width', () => {
  expect(pxToMs(-50, 800, 10_000)).toBe(0);
  expect(pxToMs(900, 800, 10_000)).toBe(10_000);
  expect(pxToMs(1, 3, 10_000)).toBe(3333);
});

test('вырожденные размеры: widthPx = 0 и durationMs = 0', () => {
  expect(pxToMs(100, 0, 10_000)).toBe(0);
  expect(msToPx(5000, 800, 0)).toBe(0);
  expect(msToPx(20_000, 800, 10_000)).toBe(800);
  expect(msToPx(-5, 800, 10_000)).toBe(0);
});

test('clampTrim: start ≥ end → start = end − 500', () => expect(clampTrim(9_000, 8_000, 10_000)).toEqual({ startMs: 7_500, endMs: 8_000 }));

test('clampTrim: выход за границы и черновик короче 500 мс', () => {
  expect(clampTrim(-5, 20_000, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
  expect(clampTrim(0, 300, 300)).toEqual({ startMs: 0, endMs: 300 });
  expect(clampTrim(100, 200, 10_000)).toEqual({ startMs: 0, endMs: 500 });
  expect(clampTrim(2_000.4, 5_000.6, 10_000)).toEqual({ startMs: 2_000, endMs: 5_001 });
});
