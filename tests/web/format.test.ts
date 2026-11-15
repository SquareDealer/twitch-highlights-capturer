import type { FeedClip } from '../../src/service/types';
import { clipSummary, duration, triggerLabel } from '../../src/web/format';

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
  expect(triggerLabel('mass')).toBe('массовая реакция');
  expect(triggerLabel('audio')).toBe('звук');
  expect(triggerLabel('manual')).toBe('вручную');
});
