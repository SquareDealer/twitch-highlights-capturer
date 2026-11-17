import type Database from 'better-sqlite3';
import { openDb } from '../../src/server/db';
import { defaultSettings, SettingsStore } from '../../src/server/settings';

let db: Database.Database;
let store: SettingsStore;
const defaults = defaultSettings({ videos: '/videos', userData: '/data' });
beforeEach(() => {
  db = openDb(':memory:');
  store = new SettingsStore(db, defaults);
});

test('get() без записей возвращает дефолты спеки', () => {
  const s = store.get();
  expect([s.bufferSeconds, s.segmentSeconds, s.replaySeconds, s.replayTailSeconds, s.pinBeforeMs, s.pinAfterMs]).toEqual([300, 2, 180, 5, 30_000, 60_000]);
  expect(s.libraryDir.replace(/\\/g, '/')).toBe('/videos/TwitchHighlights');
  expect(s.maxPinnedBytes).toBe(2147483648);
});

test('set() сохраняет patch и переживает новый экземпляр SettingsStore', () => {
  expect(store.set({ markerOffsetMs: -250, lastChannel: 'foo' }).markerOffsetMs).toBe(-250);
  const again = new SettingsStore(db, defaults).get();
  expect([again.markerOffsetMs, again.lastChannel, again.bufferSeconds]).toEqual([-250, 'foo', 300]);
});

test('неизвестные ключи и значения неверного типа в set() игнорируются', () => {
  const s = store.set({ nope: 1, bufferSeconds: '900', driveAutoSync: 'yes', captureLatencyMs: NaN } as never);
  expect(s).toEqual(defaults);
  expect(new SettingsStore(db, defaults).get()).toEqual(defaults);
});
