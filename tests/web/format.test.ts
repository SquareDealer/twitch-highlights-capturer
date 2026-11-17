import type { FeedClip } from '../../src/service/types';
import { clipSummary, duration, plural, signed, triggerLabel } from '../../src/web/format';

const sig = (s: Partial<FeedClip['signals']>) => ({ signals: { chatSpike: 0, laughShare: 0, reactionShare: 0, deltaDb: 0, ...s } }) as FeedClip;

test('clipSummary joins non-zero signals', () => {
  expect(clipSummary(sig({ chatSpike: 5.2, laughShare: 0.61, deltaDb: 14 }))).toBe('чат ×5,2 · смех 61 % · звук +14 дБ');
});
test('clipSummary omits zero parts and shows reaction share', () => {
  expect(clipSummary(sig({ deltaDb: 9 }))).toBe('звук +9 дБ');
  expect(clipSummary(sig({ reactionShare: 0.4 }))).toBe('реакция 40 %');
  expect(clipSummary(sig({}))).toBe('');
});
test('duration', () => {
  expect(duration(38000)).toBe('38 с');
  expect(duration(95000)).toBe('1 мин 35 с');
  expect(duration(120000)).toBe('2 мин');
});
test('triggerLabel', () => {
  expect(triggerLabel('laugh')).toBe('смех');
  expect(triggerLabel('mass')).toBe('реакция');
  expect(triggerLabel('reaction')).toBe('реакция');
  expect(triggerLabel('audio')).toBe('звук');
  expect(triggerLabel('manual')).toBe('вручную');
});
test('clipSummary shows the composition of the spike on new clips', () => {
  expect(clipSummary(sig({ chatSpike: 4, triggerShare: 0.7, triggerMessages: 7, messages: 10, laughShare: 0.5, deltaDb: 15 })))
    .toBe('чат ×4 · состав 70 % · звук +15 дБ');
});
test('clipSummary keeps the share of active chatters on clips of the older rule', () => {
  expect(clipSummary(sig({ chatSpike: 4, triggerShare: 0.1, triggerMessages: 6, activeAuthors: 40, laughShare: 0.5, deltaDb: 15 })))
    .toBe('чат ×4 · реакция 10 % активных · звук +15 дБ');
});

test('signed always carries a sign, minus is U+2212', () => {
  expect(signed(7.1)).toBe('+7,1');
  expect(signed(0)).toBe('+0');
  expect(signed(-48.1)).toBe('−48,1');
});
test('plural picks the Russian form', () => {
  const w = (n: number) => plural(n, 'сообщение', 'сообщения', 'сообщений');
  const cases: Array<[number, string]> = [[0, 'сообщений'], [1, 'сообщение'], [2, 'сообщения'], [4, 'сообщения'], [5, 'сообщений'], [11, 'сообщений'], [12, 'сообщений'], [14, 'сообщений'], [21, 'сообщение'], [22, 'сообщения'], [25, 'сообщений']];
  for (const [n, word] of cases) expect(w(n)).toBe(word);
});
