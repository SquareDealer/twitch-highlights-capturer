import type { FeedClip, Trigger } from '../service/types';

const LABELS: Record<Trigger, string> = { laugh: 'смех', mass: 'массовая реакция', audio: 'звук', manual: 'вручную' };

export const triggerLabel = (t: Trigger): string => LABELS[t];

/** Russian decimal comma, trailing zeros dropped: 5.2 → '5,2', 5 → '5'. */
export const num = (x: number, digits = 1): string => String(Number(x.toFixed(digits))).replace('.', ',');

export function clipSummary(c: FeedClip): string {
  const s = c.signals;
  const parts: string[] = [];
  if (s.chatSpike > 0) parts.push(`чат ×${num(s.chatSpike)}`);
  if (Math.round(s.laughShare * 100) > 0) parts.push(`смех ${Math.round(s.laughShare * 100)} %`);
  if (Math.round(s.reactionShare * 100) > 0) parts.push(`реакция ${Math.round(s.reactionShare * 100)} %`);
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

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
