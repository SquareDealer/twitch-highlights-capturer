import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Db } from '../main/db';
import { migrateSettings, validateSettings, type ProfileSettings } from './profileSettings';

export interface Profile {
  id: string; name: string; isDefault: boolean; settings: ProfileSettings; createdAt: string; updatedAt: string;
}
export type ProfileResult<T> = { ok: true; value: T } | { ok: false; error: string; status: 400 | 404 | 409; path?: string };

export const DEFAULT_PROFILE_NAME = 'По умолчанию';

type Row = Record<string, unknown>;

const toProfile = (r: Row): Profile => ({
  id: r.id as string,
  name: r.name as string,
  isDefault: (r.is_default as number) === 1,
  settings: JSON.parse(r.settings as string) as ProfileSettings,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const fail = (status: 400 | 404 | 409, error: string, path?: string): ProfileResult<never> =>
  path === undefined ? { ok: false, error, status } : { ok: false, error, status, path };
const NOT_FOUND = 'Профиль не найден';

/**
 * Autoclip profiles and the per-channel choice. Writes to the database synchronously.
 * Events: 'updated' (Profile) after update(); 'list' (Profile[]) after create/update/remove.
 */
export class ProfileService extends EventEmitter {
  private readonly now: () => Date;
  private readonly newId: () => string;

  /** seed() is called once, only when the table is empty; its result is brought to the current shape
   *  but not validated. Profiles stored before the spike-then-composition rule are migrated here. */
  constructor(private readonly db: Db, seed: () => ProfileSettings, opts: { now?: () => Date; newId?: () => string } = {}) {
    super();
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? randomUUID;
    const n = (db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;
    if (n === 0) {
      const at = this.now().toISOString();
      db.prepare('INSERT INTO profiles (id, name, settings, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
        .run(this.newId(), DEFAULT_PROFILE_NAME, JSON.stringify(migrateSettings(seed())), at, at);
      console.log(
        'Создан профиль «По умолчанию» из config.json. Дальше пороги и параметры нарезки правятся в веб-интерфейсе ' +
          '(вкладка «Профили»); эти ключи в config.json больше не читаются.',
      );
    }
    const rows = db.prepare('SELECT id, settings FROM profiles').all() as Array<{ id: string; settings: string }>;
    for (const r of rows) {
      let stored: unknown = null;
      try { stored = JSON.parse(r.settings); } catch { /* unreadable: replaced by the factory settings below */ }
      const migrated = JSON.stringify(migrateSettings(stored));
      if (migrated !== JSON.stringify(stored)) db.prepare('UPDATE profiles SET settings = ? WHERE id = ?').run(migrated, r.id);
    }
  }

  list(): Profile[] {
    const all = (this.db.prepare('SELECT * FROM profiles').all() as Row[]).map(toProfile);
    return all.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'ru'));
  }

  get(id: string): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Row | undefined;
    return r ? toProfile(r) : null;
  }

  defaultProfile(): Profile {
    return toProfile(this.db.prepare('SELECT * FROM profiles WHERE is_default = 1').get() as Row);
  }

  create(name: unknown, copyFrom?: unknown): ProfileResult<Profile> {
    const checked = this.checkName(name, null);
    if (!checked.ok) return checked;
    let source: Profile | null;
    if (copyFrom === undefined || copyFrom === null) source = this.defaultProfile();
    else source = typeof copyFrom === 'string' ? this.get(copyFrom) : null;
    if (!source) return fail(404, NOT_FOUND);
    const at = this.now().toISOString();
    const id = this.newId();
    this.db.prepare('INSERT INTO profiles (id, name, settings, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, checked.value, JSON.stringify(source.settings), at, at);
    const created = this.get(id) as Profile;
    this.emit('list', this.list());
    return { ok: true, value: created };
  }

  update(id: string, patch: { name?: unknown; settings?: unknown }): ProfileResult<Profile> {
    const current = this.get(id);
    if (!current) return fail(404, NOT_FOUND);
    if (patch.name === undefined && patch.settings === undefined) return fail(400, 'Некорректный запрос');
    let name = current.name;
    let settings = current.settings;
    if (patch.name !== undefined) {
      const checked = this.checkName(patch.name, id);
      if (!checked.ok) return checked;
      name = checked.value;
    }
    if (patch.settings !== undefined) {
      const v = validateSettings(patch.settings);
      if (!v.ok) return fail(400, v.error, v.path);
      settings = v.value;
    }
    this.db.prepare('UPDATE profiles SET name = ?, settings = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(settings), this.now().toISOString(), id);
    const updated = this.get(id) as Profile;
    this.emit('updated', updated);
    this.emit('list', this.list());
    return { ok: true, value: updated };
  }

  remove(id: string): ProfileResult<null> {
    const current = this.get(id);
    if (!current) return fail(404, NOT_FOUND);
    if (current.isDefault) return fail(409, 'Профиль «По умолчанию» нельзя удалить');
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id); // channel_profiles rows go with it (ON DELETE CASCADE)
    this.emit('list', this.list());
    return { ok: true, value: null };
  }

  /** The remembered profile of the channel, otherwise the default one. */
  forChannel(channel: string): Profile {
    const r = this.db
      .prepare('SELECT p.* FROM channel_profiles c JOIN profiles p ON p.id = c.profile_id WHERE c.channel = ?')
      .get(channel) as Row | undefined;
    return r ? toProfile(r) : this.defaultProfile();
  }

  remember(channel: string, profileId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO channel_profiles (channel, profile_id) VALUES (?, ?)').run(channel, profileId);
  }

  /** Name rules; uniqueness is case-insensitive in all alphabets (SQLite NOCASE only folds ASCII). */
  private checkName(name: unknown, selfId: string | null): ProfileResult<string> {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed === '' || trimmed.length > 60) return fail(400, 'Название профиля: от 1 до 60 символов');
    const key = trimmed.toLowerCase();
    const rows = this.db.prepare('SELECT id, name FROM profiles').all() as Array<{ id: string; name: string }>;
    if (rows.some((r) => r.id !== selfId && r.name.toLowerCase() === key)) return fail(409, 'Профиль с таким названием уже есть');
    return { ok: true, value: trimmed };
  }
}
