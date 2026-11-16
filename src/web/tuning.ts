import { DICTIONARIES, FIELDS, type ProfileSettings } from '../service/profileSettings';
import type { DetectorDetail, DetectorSignals } from '../service/detectorProcess';
import type { TuningEntry } from '../service/tuningLog';
import { duration, num, triggerLabel } from './format';

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

export interface ConditionRow { ok: boolean; label: string; value: string; need: string }

const pct = (p: number) => `${num(p * 100)} %`;

export function conditionRows(d: DetectorDetail, s: ProfileSettings): ConditionRow[] {
  const c = d.chat;
  const t = s.detector.chat;
  return [
    { ok: d.conditions.warm, label: 'прогрев', value: `идёт ${duration(d.sinceStartMs)}`, need: `нужно ${num(s.detector.events.warmupS)} с` },
    { ok: d.conditions.messages, label: 'триггерных сообщений', value: `${c.triggerMessages}`, need: `≥ ${t.minTriggerMessages}` },
    { ok: d.conditions.authors, label: 'авторов', value: `${c.triggerAuthors}`, need: `≥ ${t.minTriggerAuthors}` },
    { ok: d.conditions.share, label: 'доля активных', value: `${pct(c.triggerShare)} (${c.triggerAuthors} из ${c.activeAuthors})`, need: `≥ ${pct(t.minTriggerShare)}` },
  ];
}

export function verdict(d: DetectorDetail): string {
  if (d.conditions.fired) return 'сработало';
  const missing = [
    !d.conditions.warm && 'прогрева',
    !d.conditions.messages && 'сообщений',
    !d.conditions.authors && 'авторов',
    !d.conditions.share && 'доли',
  ].filter(Boolean);
  return `не сработало: не хватает ${missing.join(', ')}`;
}

const MISSING: Record<string, string> = { share: 'доли', authors: 'авторов', warm: 'прогрева' };

export function entryText(e: TuningEntry): string {
  switch (e.kind) {
    case 'clip':
      return `клип ${num(e.scores.total)} · ${e.triggers.map(triggerLabel).join(' + ')} · доля ${num(e.scores.share)} + скорость ${num(e.scores.speed)} + звук ${num(e.scores.audio)}`;
    case 'nearmiss': {
      const v = e.values;
      return `почти: не хватает ${e.missing.map((m) => MISSING[m] ?? m).join(', ')} · ${v.triggerMessages} сообщ., ${v.triggerAuthors} авт., доля ${pct(v.triggerShare ?? 0)}`;
    }
    case 'limited':
      return `событие ${num(e.scores.total)} отброшено: лимит ${e.limit} клипов в час, медиана ${num(e.median)}`;
    case 'paused':
      return `событие ${num(e.scores.total)} отброшено: ${e.reason}`;
    case 'profile':
      if (e.error) return `профиль «${e.name}» не применён: ${e.error}`;
      return `применён профиль «${e.name}»${e.badPatterns.length > 0 ? ` · не используется: ${e.badPatterns.join(', ')}` : ''}`;
  }
}

export function mergeFrames(a: DetectorSignals[], b: DetectorSignals[]): DetectorSignals[] {
  const byTime = new Map<number, DetectorSignals>();
  for (const f of [...a, ...b]) byTime.set(f.tMs, f);
  return [...byTime.values()].sort((x, y) => x.tMs - y.tMs).slice(-300);
}

const storageKey = (channel: string) => `hl.tuning.${channel}`;

export function tuningStored(channel: string): boolean {
  try {
    return localStorage.getItem(storageKey(channel)) === '1';
  } catch {
    return false;
  }
}

export function storeTuning(channel: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(storageKey(channel), '1');
    else localStorage.removeItem(storageKey(channel));
  } catch {
    /* storage unavailable: the switch just is not remembered */
  }
}
