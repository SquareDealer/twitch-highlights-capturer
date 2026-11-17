import { openDb, type Db } from '../../src/main/db';
import { defaultConfig } from '../../src/service/config';
import { settingsFromConfig, type ProfileSettings } from '../../src/service/profileSettings';
import { ProfileService, type Profile, type ProfileResult } from '../../src/service/profiles';

const SEED = settingsFromConfig(defaultConfig('/d'));

function ok<T>(r: ProfileResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`);
  return r.value;
}

let db: Db;
let counter: number;
let clock: number;
let s: ProfileService;
const make = (seed: () => ProfileSettings = () => SEED) =>
  new ProfileService(db, seed, { newId: () => `p${++counter}`, now: () => new Date(clock) });

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  db = openDb(':memory:');
  counter = 0;
  clock = Date.parse('2026-11-16T10:00:00.000Z');
  s = make();
  log.mockClear();
});
afterEach(() => log.mockRestore());

it('seeds the default profile once', () => {
  const seed = vi.fn(() => SEED);
  const fresh = openDb(':memory:');
  const a = new ProfileService(fresh, seed);
  expect(a.list()).toMatchObject([{ name: 'По умолчанию', isDefault: true, settings: SEED }]);
  new ProfileService(fresh, seed);
  expect(seed).toHaveBeenCalledTimes(1);
});

it('seeds values that fail validation as they are; saving them is refused', () => {
  const bad = structuredClone(SEED);
  bad.detector.score.shareFull = 0.01;
  const svc = new ProfileService(openDb(':memory:'), () => bad);
  expect(svc.defaultProfile().settings.detector.score.shareFull).toBe(0.01);
  expect(svc.update(svc.defaultProfile().id, { settings: bad })).toMatchObject({
    ok: false, status: 400, path: 'detector.score.shareFull',
  });
});

it('creates a copy of the default or of the given profile', () => {
  const a = ok(s.create('А'));
  expect(a.isDefault).toBe(false);
  expect(a.settings).toEqual(s.defaultProfile().settings);
  const changed = structuredClone(SEED);
  changed.cut.postRollMs = 1234;
  ok(s.update(a.id, { settings: changed }));
  const b = ok(s.create('Б', a.id));
  expect(b.settings.cut.postRollMs).toBe(1234);
  expect(s.create('В', 'nope')).toEqual({ ok: false, status: 404, error: 'Профиль не найден' });
});

it('rejects bad and duplicate names', () => {
  const msg = 'Название профиля: от 1 до 60 символов';
  for (const n of ['', '  ', 'x'.repeat(61), 5, null, undefined]) {
    expect(s.create(n)).toEqual({ ok: false, status: 400, error: msg });
  }
  expect(s.create('по УМОЛЧАНИЮ')).toEqual({ ok: false, status: 409, error: 'Профиль с таким названием уже есть' });
  expect(s.create('x'.repeat(60)).ok).toBe(true);
});

it('updates name and settings, bumps updatedAt, emits updated and list', () => {
  const p = ok(s.create('А'));
  const updated: Profile[] = [];
  const lists: Profile[][] = [];
  s.on('updated', (x: Profile) => updated.push(x));
  s.on('list', (x: Profile[]) => lists.push(x));
  clock += 5000;
  const next = structuredClone(SEED);
  next.cut.maxClipsPerHour = 7;
  const r = ok(s.update(p.id, { name: ' Новое ', settings: next }));
  expect(r.name).toBe('Новое');
  expect(r.settings.cut.maxClipsPerHour).toBe(7);
  expect(r.createdAt).toBe(p.createdAt);
  expect(r.updatedAt).toBe('2026-11-16T10:00:05.000Z');
  expect(s.get(p.id)).toEqual(r);
  expect(updated).toEqual([r]);
  expect(lists).toHaveLength(1);
  expect(lists[0]!.map((x) => x.name)).toEqual(['По умолчанию', 'Новое']);
});

it('rejects an empty patch and an unknown id', () => {
  const p = ok(s.create('А'));
  expect(s.update(p.id, {})).toEqual({ ok: false, status: 400, error: 'Некорректный запрос' });
  expect(s.update('nope', { name: 'Б' })).toEqual({ ok: false, status: 404, error: 'Профиль не найден' });
});

it('does not change anything when the settings are invalid', () => {
  const p = ok(s.create('А'));
  const before = s.get(p.id);
  const events: string[] = [];
  s.on('updated', () => events.push('updated'));
  s.on('list', () => events.push('list'));
  const bad = structuredClone(SEED);
  bad.cut.maxClipsPerHour = 0;
  clock += 5000;
  expect(s.update(p.id, { name: 'Другое', settings: bad })).toMatchObject({
    ok: false, status: 400, path: 'cut.maxClipsPerHour',
  });
  expect(s.get(p.id)).toEqual(before);
  expect(events).toEqual([]);
});

it('renaming to the same name in another case is allowed', () => {
  const p = ok(s.create('Профиль'));
  expect(ok(s.update(p.id, { name: 'ПРОФИЛЬ' })).name).toBe('ПРОФИЛЬ');
  const q = ok(s.create('Другой'));
  expect(s.update(q.id, { name: 'профиль' })).toMatchObject({ ok: false, status: 409 });
});

it('removes a profile and emits list; unknown id is 404', () => {
  const p = ok(s.create('А'));
  const lists: Profile[][] = [];
  s.on('list', (x: Profile[]) => lists.push(x));
  expect(s.remove(p.id)).toEqual({ ok: true, value: null });
  expect(s.get(p.id)).toBeNull();
  expect(lists).toHaveLength(1);
  expect(s.remove(p.id)).toEqual({ ok: false, status: 404, error: 'Профиль не найден' });
});

it('refuses to delete the default profile', () => {
  expect(s.remove(s.defaultProfile().id)).toEqual({
    ok: false, status: 409, error: 'Профиль «По умолчанию» нельзя удалить',
  });
  expect(s.list()).toHaveLength(1);
});

it('remembers a profile per channel and falls back to the default', () => {
  const p = ok(s.create('Крупный канал'));
  s.remember('shroud', p.id);
  expect(s.forChannel('shroud').id).toBe(p.id);
  expect(s.forChannel('other').isDefault).toBe(true);
  s.remove(p.id);
  expect(s.forChannel('shroud').isDefault).toBe(true);
});

it('lists the default first, then by name', () => {
  ok(s.create('Яблоко'));
  ok(s.create('Арбуз'));
  ok(s.create('Банан'));
  expect(s.list().map((p) => p.name)).toEqual(['По умолчанию', 'Арбуз', 'Банан', 'Яблоко']);
});

it('logs the seeding once', () => {
  const fresh = openDb(':memory:');
  new ProfileService(fresh, () => SEED);
  new ProfileService(fresh, () => SEED);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]![0]).toContain('Создан профиль «По умолчанию» из config.json');
});

describe('profiles stored before the spike-then-composition rule', () => {
  const oldShape = (): any => {
    const o: any = JSON.parse(JSON.stringify(SEED));
    delete o.detector.chat.minSpike;
    Object.assign(o.detector.chat, { minTriggerShare: 0.05, minActive: 10, activeWindowS: 300 });
    o.detector.score.shareFull = 0.3;
    o.cut.preRollMs = 7000;
    return o;
  };
  it('are migrated when the service starts', () => {
    db.prepare("UPDATE profiles SET settings = ?").run(JSON.stringify(oldShape()));
    const st = make().defaultProfile().settings;
    expect(st.detector.chat).toMatchObject({ minSpike: 2, minTriggerShare: 0.5 });
    expect(st.detector.score.shareFull).toBe(0.9);
    expect(st.cut.preRollMs).toBe(7000);
    expect('minActive' in st.detector.chat).toBe(false);
  });
  it('are migrated when they come from the seed', () => {
    db.prepare('DELETE FROM profiles').run();
    expect(make(oldShape).defaultProfile().settings.detector.chat).toMatchObject({ minSpike: 2, minTriggerShare: 0.5 });
  });
});
