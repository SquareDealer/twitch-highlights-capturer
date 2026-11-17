import { DICTIONARIES, FIELDS, type FieldDef, type ProfileSettings } from '../service/profileSettings';
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
    { ok: d.conditions.spike, label: 'всплеск', value: `×${num(c.spike)}`, need: `≥ ×${num(t.minSpike)}` },
    { ok: d.conditions.share, label: 'состав', value: `${pct(c.triggerShare)} (${c.triggerMessages} из ${c.messages})`, need: `≥ ${pct(t.minTriggerShare)}` },
    { ok: d.conditions.messages, label: 'триггерных сообщений', value: `${c.triggerMessages}`, need: `≥ ${t.minTriggerMessages}` },
    { ok: d.conditions.authors, label: 'авторов', value: `${c.triggerAuthors}`, need: `≥ ${t.minTriggerAuthors}` },
  ];
}

export function verdict(d: DetectorDetail): string {
  if (d.conditions.fired) return 'сработало';
  const missing = [
    !d.conditions.warm && 'прогрева',
    !d.conditions.spike && 'всплеска',
    !d.conditions.share && 'состава',
    !d.conditions.messages && 'сообщений',
    !d.conditions.authors && 'авторов',
  ].filter(Boolean);
  return `не сработало: не хватает ${missing.join(', ')}`;
}

const MISSING: Record<string, string> = { warm: 'прогрева', spike: 'всплеска', share: 'состава', messages: 'сообщений', authors: 'авторов' };

export function entryText(e: TuningEntry): string {
  switch (e.kind) {
    case 'clip':
      return `клип ${num(e.scores.total)} · ${e.triggers.map(triggerLabel).join(' + ')} · скорость ${num(e.scores.speed)} + состав ${num(e.scores.share)} + звук ${num(e.scores.audio)}`;
    case 'nearmiss': {
      const v = e.values;
      return `почти: не хватает ${e.missing.map((m) => MISSING[m] ?? m).join(', ')} · чат ×${num(v.spike ?? 0)} · состав ${pct(v.triggerShare ?? 0)} (${v.triggerMessages ?? 0} из ${v.messages ?? 0}) · ${v.triggerAuthors ?? 0} авт.`;
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

/** Keyed and ordered by (epoch, tMs): tMs restarts from 0 in every new epoch (a Twitch reconnect). */
export function mergeFrames(a: DetectorSignals[], b: DetectorSignals[]): DetectorSignals[] {
  const byTime = new Map<string, DetectorSignals>();
  for (const f of [...a, ...b]) byTime.set(`${f.epoch ?? 0}:${f.tMs}`, f);
  return [...byTime.values()].sort((x, y) => (x.epoch ?? 0) - (y.epoch ?? 0) || x.tMs - y.tMs).slice(-300);
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

/** The thresholds the trigger rule compares a second against. */
export interface Thresholds { minSpike: number; minTriggerShare: number; minTriggerMessages: number; minTriggerAuthors: number }

export const thresholdsOf = (s: ProfileSettings): Thresholds => {
  const c = s.detector.chat;
  return { minSpike: c.minSpike, minTriggerShare: c.minTriggerShare, minTriggerMessages: c.minTriggerMessages, minTriggerAuthors: c.minTriggerAuthors };
};

/** The detector's rule (EventAssembler.conditions) applied to a stored frame with other thresholds.
 *  null: the frame carries no detail and cannot be judged. */
export function firedWith(f: DetectorSignals, t: Thresholds): boolean | null {
  const d = f.detail;
  if (!d) return null;
  const c = d.chat;
  return (
    d.conditions.warm && c.spike >= t.minSpike && c.messages > 0 && c.triggerShare >= t.minTriggerShare &&
    c.triggerMessages >= t.minTriggerMessages && c.triggerAuthors >= t.minTriggerAuthors
  );
}

/** Indexes of the frames that start a firing: fired, and the previous judged frame did not. */
export function firingStarts(frames: DetectorSignals[], t: Thresholds): number[] {
  const out: number[] = [];
  let prev = false;
  frames.forEach((f, i) => {
    const fired = firedWith(f, t);
    if (fired === null) return;
    if (fired && !prev) out.push(i);
    prev = fired;
  });
  return out;
}

/** A value brought into the field's min…max and onto its step grid; not a number → min. */
export function clampField(def: FieldDef, v: number): number {
  if (!Number.isFinite(v)) return def.min;
  const stepped = Math.round(v / def.step) * def.step;
  return Math.min(def.max, Math.max(def.min, Number(stepped.toFixed(6))));
}
