import type { Marker } from '@shared/types';
import { formatTimecode, toClipMarkers } from '@shared/time';

const m = (id: string, epoch: number, t: number): Marker => ({ id, momentId: 'm', epoch, type: 2, sourceTimeMs: t, comment: '' });

test('пример из спеки: маркер 02:10, начало обрезки 01:40 → 00:30', () => {
  expect(toClipMarkers([m('a', 0, 130_000)], { epoch: 0, startMs: 0 }, 100_000, 180_000)).toEqual([
    { id: 'a', type: 2, timeMs: 30_000, comment: '' },
  ]);
});

test('учитывает начало черновика, отбрасывает маркеры вне trim и чужой эпохи, сортирует', () => {
  const out = toClipMarkers(
    [m('late', 0, 70_000), m('in', 0, 65_000), m('before', 0, 61_000), m('after', 0, 81_000), m('other', 1, 65_000)],
    { epoch: 0, startMs: 60_000 },
    2_000,
    20_000,
  );
  expect(out.map((x) => [x.id, x.timeMs])).toEqual([
    ['in', 3_000],
    ['late', 8_000],
  ]);
});

test('границы trim включительно', () => {
  expect(toClipMarkers([m('s', 0, 1_000), m('e', 0, 5_000)], { epoch: 0, startMs: 0 }, 1_000, 5_000).map((x) => x.timeMs)).toEqual([0, 4_000]);
});

test('formatTimecode', () => {
  expect(formatTimecode(151_420)).toBe('02:31.420');
  expect(formatTimecode(0)).toBe('00:00.000');
  expect(formatTimecode(3_723_004)).toBe('62:03.004');
});
