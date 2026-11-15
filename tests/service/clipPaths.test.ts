import { join } from 'node:path';
import { feedClipPaths } from '../../src/service/clipPaths';

const session = { streamer: 'alice', streamId: '42', startedAt: new Date(2026, 10, 14, 18, 30).toISOString() };

test('строит путь библиотека/канал/эфир/клип с триггерами и 4 hex id', () => {
  const p = feedClipPaths('/lib', session, new Date(2026, 10, 15, 9, 8, 7), ['laugh', 'mass'], 'abcd-1234-ef56');
  expect(p.dir).toBe(join('/lib', 'alice', '42_2026-11-14_18-30'));
  expect(p.mp4Path).toBe(join(p.dir, '2026-11-15_09-08-07_laugh+mass_ef56.mp4'));
  expect(p.jsonPath).toBe(join(p.dir, '2026-11-15_09-08-07_laugh+mass_ef56.json'));
});

test('небезопасные символы канала вычищаются, короткий id дополняется нулями', () => {
  const p = feedClipPaths('/lib', { ...session, streamer: '../a/b' }, new Date(2026, 0, 1, 0, 0, 0), ['manual'], 'g1');
  expect(p.dir.startsWith(join('/lib', 'ab'))).toBe(true);
  expect(p.mp4Path.endsWith('_manual_0001.mp4')).toBe(true);
});
