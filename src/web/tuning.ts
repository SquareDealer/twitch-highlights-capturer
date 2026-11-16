import { DICTIONARIES, FIELDS, type ProfileSettings } from '../service/profileSettings';
import { num } from './format';

/** Trims, accepts a decimal comma; '' and anything that is not a plain number give null. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : null;
}

/** path → text of the field; dictionaries are one pattern per line. */
export type FormValues = Record<string, string>;

const read = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root);

function write(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = root;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[keys[keys.length - 1]!] = value;
}

export function toForm(s: ProfileSettings): FormValues {
  const f: FormValues = {};
  for (const d of FIELDS) f[d.path] = num(read(s, d.path) as number, 6);
  for (const d of DICTIONARIES) f[d.path] = (read(s, d.path) as string[]).join('\n');
  return f;
}

/** Parsing only: bounds and patterns are checked by the server. */
export function fromForm(f: FormValues): { ok: true; value: ProfileSettings } | { ok: false; path: string; error: string } {
  const out: Record<string, unknown> = {};
  for (const d of FIELDS) {
    const v = parseNumber(f[d.path] ?? '');
    if (v === null) return { ok: false, path: d.path, error: `«${d.label}»: нужно число` };
    write(out, d.path, v);
  }
  for (const d of DICTIONARIES) {
    const text = f[d.path] ?? '';
    write(out, d.path, text === '' ? [] : text.split(/\r?\n/));
  }
  return { ok: true, value: out as unknown as ProfileSettings };
}
