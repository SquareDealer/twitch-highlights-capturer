import type { FeedClip, Trigger } from '../service/types';

const LABELS: Record<Trigger, string> = { laugh: 'смех', reaction: 'реакция', mass: 'реакция', audio: 'звук', manual: 'вручную' };

export const triggerLabel = (t: Trigger): string => LABELS[t];

/** Russian decimal comma, trailing zeros dropped: 5.2 → '5,2', 5 → '5'. */
export const num = (x: number, digits = 1): string => String(Number(x.toFixed(digits))).replace('.', ',');

/** Typographic minus (U+2212) instead of the ASCII hyphen. */
export const minus = (s: string): string => s.replace('-', '−');

/** `num` with U+2212 for negatives: -48.1 → '−48,1'. */
export const numM = (x: number, digits = 1): string => minus(num(x, digits));

/** `num` that always carries a sign: 7.1 → '+7,1', 0 → '+0', -48.1 → '−48,1'. */
export const signed = (x: number, digits = 1): string => {
  const s = num(x, digits);
  return s.startsWith('-') ? minus(s) : `+${s}`;
};

/** Russian plural form: 1 → one, 2–4 → few, 0/5–20 → many, 21 → one, 22 → few. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function clipSummary(c: Pick<FeedClip, 'signals'>): string {
  const s = c.signals;
  const parts: string[] = [];
  if (s.chatSpike > 0) parts.push(`чат ×${num(s.chatSpike)}`);
  if (s.triggerShare !== undefined) {
    // Clips of the older rule carry activeAuthors: their share is a share of active chatters.
    const pct = Math.round(s.triggerShare * 100);
    if (pct > 0) parts.push(s.activeAuthors !== undefined ? `реакция ${pct} % активных` : `состав ${pct} %`);
  } else {
    if (Math.round(s.laughShare * 100) > 0) parts.push(`смех ${Math.round(s.laughShare * 100)} %`);
    if (Math.round(s.reactionShare * 100) > 0) parts.push(`реакция ${Math.round(s.reactionShare * 100)} %`);
  }
  if (Math.round(s.deltaDb) > 0) parts.push(`звук +${Math.round(s.deltaDb)} дБ`);
  return parts.join(' · ');
}

export function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} с`;
  return s === 0 ? `${m} мин` : `${m} мин ${s} с`;
}

export function clockTime(iso: string, seconds = false): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('ru-RU', seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
}
