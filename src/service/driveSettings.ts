import type { Db } from '../main/db';

export interface DriveFolder { id: string; name: string; path: string }
export interface DriveSettings { clientId: string; clientSecret: string; folder: DriveFolder | null }

const KEYS = { clientId: 'drive.clientId', clientSecret: 'drive.clientSecret', folder: 'drive.folder' } as const;

function parseFolder(text: string | undefined): DriveFolder | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<DriveFolder> | null;
    return v && typeof v.id === 'string' && v.id && typeof v.name === 'string' && typeof v.path === 'string'
      ? { id: v.id, name: v.name, path: v.path }
      : null;
  } catch {
    return null;
  }
}

/** Google OAuth client keys and the upload folder, kept in the service database (`settings` table). */
export function createDriveSettings(db: Db) {
  const read = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const write = (key: string, value: string) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  return {
    get(): DriveSettings {
      return { clientId: read(KEYS.clientId) ?? '', clientSecret: read(KEYS.clientSecret) ?? '', folder: parseFolder(read(KEYS.folder)) };
    },
    setCredentials(clientId: string, clientSecret: string): void {
      db.transaction(() => {
        write(KEYS.clientId, clientId.trim());
        write(KEYS.clientSecret, clientSecret.trim());
      })();
    },
    setFolder(f: DriveFolder | null): void {
      if (f) write(KEYS.folder, JSON.stringify({ id: f.id, name: f.name, path: f.path }));
      else db.prepare('DELETE FROM settings WHERE key = ?').run(KEYS.folder);
    },
  };
}
export type DriveSettingsStore = ReturnType<typeof createDriveSettings>;
