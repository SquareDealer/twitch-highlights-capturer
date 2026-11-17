// @vitest-environment jsdom
import type { DetectorDetail, DetectorSignals } from '../../src/service/detectorProcess';
import { defaultConfig } from '../../src/service/config';
import { settingsFromConfig } from '../../src/service/profileSettings';
import { conditionRows, entryText, fromForm, mergeFrames, parseNumber, storeTuning, toForm, tuningStored, verdict } from '../../src/web/tuning';

const SEED = settingsFromConfig(defaultConfig('/d'));

it.each([['0,05', 0.05], [' 12 ', 12], ['1.5', 1.5], ['-3', -3]])('parses %s', (t, v) => expect(parseNumber(t)).toBe(v));
it.each(['', '  ', 'abc', '1,2,3', '5 с'])('rejects %j', (t) => expect(parseNumber(t)).toBeNull());
it('round-trips the defaults through the form', () => expect(fromForm(toForm(SEED))).toEqual({ ok: true, value: SEED }));
it('shows decimals with a comma', () => expect(toForm(SEED)['detector.chat.minTriggerShare']).toBe('0,5'));
it('names the field that is not a number', () => {
  expect(fromForm({ ...toForm(SEED), 'cut.postRollMs': '' })).toEqual({ ok: false, path: 'cut.postRollMs', error: '«Запас после события»: нужно число' });
});
it('splits dictionaries by line', () => {
  const r = fromForm({ ...toForm(SEED), 'detector.chat.laughWords': '^lol$\r\n\n ^kek$ ' });
  expect(r.ok && r.value.detector.chat.laughWords).toEqual(['^lol$', '', ' ^kek$ ']); // the server cleans them
});

const S = SEED;
const D: DetectorDetail = {
  configVersion: 1, sinceStartMs: 720000,
  chat: { messages: 40, authors: 20, baseline: 2, spike: 3, triggerMessages: 5, triggerAuthors: 4, laughMessages: 4, reactionMessages: 1, triggerShare: 0.125 },
  conditions: { warm: true, spike: true, messages: true, authors: true, share: false, fired: false },
  audio: { db: -20, baselineDb: -30, deltaDb: 10, vad: 0.5, warm: true, spiking: false },
  score: { total: 1, share: 0, speed: 0, audio: 0 }, event: null,
};

it('builds the condition rows in rule order against the profile thresholds', () => {
  expect(conditionRows(D, S)).toEqual([
    { ok: true, label: 'прогрев', value: 'идёт 12 мин', need: 'нужно 60 с' },
    { ok: true, label: 'всплеск', value: '×3', need: '≥ ×2' },
    { ok: false, label: 'состав', value: '12,5 % (5 из 40)', need: '≥ 50 %' },
    { ok: true, label: 'триггерных сообщений', value: '5', need: '≥ 3' },
    { ok: true, label: 'авторов', value: '4', need: '≥ 2' },
  ]);
});
it('says what is missing', () => {
  expect(verdict(D)).toBe('не сработало: не хватает состава');
  expect(verdict({ ...D, conditions: { ...D.conditions, spike: false } })).toBe('не сработало: не хватает всплеска, состава');
  expect(verdict({ ...D, conditions: { warm: false, spike: true, messages: false, authors: true, share: true, fired: false } })).toBe('не сработало: не хватает прогрева, сообщений');
  expect(verdict({ ...D, conditions: { ...D.conditions, share: true, fired: true } })).toBe('сработало');
});
it('describes log entries', () => {
  expect(entryText({ at: '', kind: 'clip', clipId: 'c', triggers: ['laugh', 'audio'], scores: { total: 4.3, share: 1, speed: 1.8, audio: 0.5 } }))
    .toBe('клип 4,3 · смех + звук · скорость 1,8 + состав 1 + звук 0,5');
  expect(entryText({ at: '', kind: 'limited', scores: { total: 2.1, share: 0, speed: 0, audio: 0 }, limit: 20, median: 3.4 }))
    .toBe('событие 2,1 отброшено: лимит 20 клипов в час, медиана 3,4');
  expect(entryText({ at: '', kind: 'paused', scores: { total: 2.1, share: 0, speed: 0, audio: 0 }, reason: 'нет места' }))
    .toBe('событие 2,1 отброшено: нет места');
  expect(entryText({ at: '', kind: 'nearmiss', missing: ['share'], values: { spike: 2.6, messages: 16, triggerMessages: 5, triggerAuthors: 4, triggerShare: 0.3125 } }))
    .toBe('почти: не хватает состава · чат ×2,6 · состав 31,3 % (5 из 16) · 4 авт.');
  expect(entryText({ at: '', kind: 'nearmiss', missing: ['spike', 'messages'], values: {} })).toBe('почти: не хватает всплеска, сообщений · чат ×0 · состав 0 % (0 из 0) · 0 авт.');
  expect(entryText({ at: '', kind: 'profile', name: 'Крупный канал', version: 2, badPatterns: [] })).toBe('применён профиль «Крупный канал»');
  expect(entryText({ at: '', kind: 'profile', name: 'А', version: 2, badPatterns: ['(a+)+'] })).toBe('применён профиль «А» · не используется: (a+)+');
  expect(entryText({ at: '', kind: 'profile', name: 'А', version: 2, badPatterns: [], error: 'x' })).toBe('профиль «А» не применён: x');
});
it('merges frames by time without duplicates and keeps the last 300', () => {
  const f = (tMs: number): DetectorSignals => ({ tMs, chatSpike: 0, laughShare: 0, messages: 0, deltaDb: 0, vad: 0, warm: true });
  const a = Array.from({ length: 250 }, (_, i) => f(i * 1000));
  const b = Array.from({ length: 150 }, (_, i) => f((200 + i) * 1000));
  const m = mergeFrames(b, a);
  expect(m).toHaveLength(300);
  expect(m[0]!.tMs).toBe(50000);
  expect(m[299]!.tMs).toBe(349000);
  expect(mergeFrames([f(2000), f(1000)], [f(2000)]).map((x) => x.tMs)).toEqual([1000, 2000]);
});
it('remembers the switch and survives a blocked localStorage', () => {
  expect(tuningStored('a')).toBe(false);
  storeTuning('a', true);
  expect(tuningStored('a')).toBe(true);
  storeTuning('a', false);
  expect(tuningStored('a')).toBe(false);
  const boom = () => { throw new Error('blocked'); };
  vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
  expect(tuningStored('a')).toBe(false);
  expect(() => storeTuning('a', true)).not.toThrow();
  vi.unstubAllGlobals();
});
it('orders frames by epoch first, so frames after a reconnect stay last', () => {
  const f = (epoch: number, tMs: number): DetectorSignals => ({ epoch, tMs, chatSpike: 0, laughShare: 0, messages: 0, deltaDb: 0, vad: 0, warm: true });
  const old = Array.from({ length: 11 }, (_, i) => f(1, 290000 + i * 1000));
  const fresh = Array.from({ length: 5 }, (_, i) => f(2, 1000 + i * 1000));
  const m = mergeFrames(old, fresh);
  expect(m).toHaveLength(16);
  expect(m.slice(-5).map((x) => [x.epoch, x.tMs])).toEqual([[2, 1000], [2, 2000], [2, 3000], [2, 4000], [2, 5000]]);
  const full = mergeFrames(Array.from({ length: 300 }, (_, i) => f(1, i * 1000)), fresh);
  expect(full).toHaveLength(300);
  expect(full[299]).toEqual(f(2, 5000));
  expect(mergeFrames([f(1, 1000)], [f(2, 1000)])).toHaveLength(2); // same tMs, different epochs
});
