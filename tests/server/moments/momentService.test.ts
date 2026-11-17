import type { Draft, Marker } from '@shared/types';
import { makeWorld, WALL0, type World } from './fixtures';

let w: World;
beforeEach(() => {
  w = makeWorld();
  w.feed(0, 0, 200_000);
});

const add = (type: Marker['type'], sourceMs: number): Marker => {
  const r = w.moments.addMarker(type, WALL0 + sourceMs);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const active = () => w.repos.moments.activeFor('s1')!;
const draft = (over: Partial<Draft> = {}): Draft => {
  const d = { id: 'd1', sessionId: 's1', epoch: 0, startMs: 100_000, endMs: 160_000, filePath: '/d/d1.mp4', createdAt: 'x', ...over };
  w.repos.drafts.insert(d);
  return d;
};

test('время маркера — от wallMs нажатия; setComment через 10 с его не меняет', () => {
  const m = add(2, 151_420);
  expect(m).toMatchObject({ type: 2, epoch: 0, sourceTimeMs: 151_420, comment: '' });
  w.clock.now += 10_000;
  w.moments.setComment(m.id, '  смешно  ');
  expect(active().markers).toEqual([{ ...m, comment: 'смешно' }]);
});

test('повторное нажатие той же цифры создаёт второй маркер того же type', () => {
  add(2, 10_000);
  add(2, 20_000);
  expect(active().markers.map((m) => [m.type, m.sourceTimeMs])).toEqual([[2, 10_000], [2, 20_000]]);
});

test('addMarker закрепляет [t − 30 000, t + 60 000] под id маркера', async () => {
  add(1, 100_000);
  expect(await w.survives(0, 70_000)).toBe(true);
  expect(w.ring.select(0, 0, 1e9).map((s) => s.startMs)).toEqual(Array.from({ length: 45 }, (_, i) => 70_000 + i * 2000));
});

test.each([
  ['нет сессии', (x: World) => x.setSession(null)],
  ['CONNECTING', (x: World) => x.setState('CONNECTING')],
  ['RECONNECTING', (x: World) => x.setState('RECONNECTING')],
  ['RECORDING без сегментов', (x: World) => x.timeSync.reset()],
])('addMarker при «%s» → ok:false, маркер не создан', (_name, arrange) => {
  arrange(w);
  expect(w.moments.addMarker(3, WALL0 + 5000)).toEqual({ ok: false, error: 'Запись не идёт — маркер не поставлен' });
  expect(w.repos.moments.activeFor('s1')?.markers ?? []).toEqual([]);
});

test('setComment("") допустим; комментарий длиннее 500 символов обрезается', () => {
  const m = add(1, 5000);
  w.moments.setComment(m.id, 'x'.repeat(600));
  expect(w.repos.markers.get(m.id)!.comment).toHaveLength(500);
  w.moments.setComment(m.id, '');
  expect(w.repos.markers.get(m.id)!.comment).toBe('');
  expect(() => w.moments.setComment('missing', 'x')).not.toThrow();
});

test('updateMarker(sourceTimeMs) перезакрепляет диапазон и не уходит ниже 0', async () => {
  const m = add(1, 150_000);
  w.moments.updateMarker(m.id, { sourceTimeMs: 20_000.4, type: 9, comment: 'c' });
  expect(w.repos.markers.get(m.id)).toMatchObject({ sourceTimeMs: 20_000, type: 9, comment: 'c' });
  expect(await w.survives(0, 0)).toBe(true);
  expect(w.ring.select(0, 150_000, 150_001)).toEqual([]);
  w.moments.updateMarker(m.id, { sourceTimeMs: -5 });
  expect(w.repos.markers.get(m.id)!.sourceTimeMs).toBe(0);
});

test('removeMarker снимает pin', async () => {
  const m = add(1, 100_000);
  w.moments.removeMarker(m.id);
  expect(active().markers).toEqual([]);
  expect(await w.survives(0, 100_000)).toBe(false);
});

test('beginExport: маркеры вне диапазона черновика и чужой эпохи переезжают в новый ACTIVE-момент с сохранением pins', async () => {
  const inside = add(1, 120_000);
  const before = active().id;
  const outside = add(2, 20_000);
  w.feed(1, 0, 10_000);
  const otherEpoch = add(3, 5000);
  expect(otherEpoch.epoch).toBe(1);
  const exporting = w.moments.beginExport(draft());
  expect(exporting).toMatchObject({ id: before, status: 'EXPORTING', draftId: 'd1' });
  expect(exporting.markers.map((m) => m.id)).toEqual([inside.id]);
  const next = active();
  expect(next.id).not.toBe(before);
  expect(next.markers.map((m) => m.id)).toEqual([outside.id, otherEpoch.id]);
  expect(await w.survives(0, 20_000)).toBe(true);
});

test('маркер, добавленный после beginExport, попадает в новый момент и переживает completeExport', async () => {
  add(1, 120_000);
  const exporting = w.moments.beginExport(draft());
  const later = add(4, 190_000);
  w.moments.completeExport(exporting.id);
  expect(active().markers.map((m) => m.id)).toEqual([later.id]);
  expect(await w.survives(0, 190_000)).toBe(true);
});

test('completeExport: SAVED и unpin; failExport: FAILED и pins на месте', async () => {
  add(1, 120_000);
  const a = w.moments.beginExport(draft());
  w.moments.failExport(a.id);
  expect(w.repos.moments.get(a.id)!.status).toBe('FAILED');
  expect(await w.survives(0, 120_000)).toBe(true);
  w.moments.completeExport(a.id);
  expect(w.repos.moments.get(a.id)!.status).toBe('SAVED');
  expect(await w.survives(0, 120_000)).toBe(false);
});

test('beginExport по FAILED-моменту не создаёт ещё один ACTIVE и не переносит маркеры', () => {
  const inside = add(1, 120_000);
  const d = draft();
  const first = w.moments.beginExport(d);
  w.moments.failExport(first.id);
  const activeBefore = active().id;
  const stray = add(5, 130_000); // belongs to the new active moment, although inside the draft range
  const again = w.moments.beginExport(d);
  expect(again).toMatchObject({ id: first.id, status: 'EXPORTING' });
  expect(again.markers.map((m) => m.id)).toEqual([inside.id]);
  expect(active().id).toBe(activeBefore);
  expect(active().markers.map((m) => m.id)).toEqual([stray.id]);
});

test('discardActive удаляет маркеры, снимает pins и оставляет пустой ACTIVE-момент', async () => {
  add(1, 100_000);
  const oldId = active().id;
  w.moments.discardActive('s1');
  expect(w.repos.moments.get(oldId)!.status).toBe('DISCARDED');
  expect(active().markers).toEqual([]);
  expect(active().id).not.toBe(oldId);
  expect(await w.survives(0, 100_000)).toBe(false);
});

test('ensureActive идемпотентен; событие changed приходит при изменениях', () => {
  const events: string[] = [];
  w.moments.on('changed', (id: string) => events.push(id));
  const a = w.moments.ensureActive('s1');
  expect(w.moments.ensureActive('s1').id).toBe(a.id);
  add(1, 1000);
  expect(events).toContain('s1');
});
