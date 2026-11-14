import { join } from 'node:path';
import type { Settings } from '@shared/types';
import type { Db } from './db';

export function defaultSettings(paths: { videos: string; userData: string }): Settings {
  return {
    libraryDir: join(paths.videos, 'TwitchHighlights'),
    bufferDir: join(paths.userData, 'buffer'),
    streamlinkPath: 'streamlink',
    ffmpegPath: 'ffmpeg',
    quality: 'best',
    lastChannel: '',
    bufferSeconds: 300,
    segmentSeconds: 2,
    replaySeconds: 180,
    replayTailSeconds: 5,
    pinBeforeMs: 30_000,
    pinAfterMs: 60_000,
    maxPinnedBytes: 2147483648,
    captureLatencyMs: 3000,
    defaultEmbedLatencyMs: 4000,
    markerOffsetMs: 0,
    driveAutoSync: true,
    driveClientId: '',
    driveClientSecret: '',
  };
}

/** Settings persisted as JSON values in the `settings` table; unknown keys and wrongly typed values are ignored. */
export class SettingsStore {
  private cache: Settings;

  constructor(private readonly db: Db, private readonly defaults: Settings) {
    this.cache = { ...defaults };
    for (const row of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
      try {
        this.apply(this.cache, row.key, JSON.parse(row.value));
      } catch {
        /* corrupt row: keep the default */
      }
    }
  }

  get(): Settings {
    return { ...this.cache };
  }

  set(patch: Partial<Settings>): Settings {
    const upsert = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (this.apply(this.cache, key, value)) upsert.run(key, JSON.stringify(value));
      }
    })();
    return this.get();
  }

  private apply(target: Settings, key: string, value: unknown): boolean {
    if (!Object.prototype.hasOwnProperty.call(this.defaults, key)) return false;
    const expected = typeof (this.defaults as unknown as Record<string, unknown>)[key];
    if (typeof value !== expected) return false;
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    (target as unknown as Record<string, unknown>)[key] = value;
    return true;
  }
}
