import type { ClipMarker, Draft, Marker } from './types';

/** Markers of the draft's epoch that fall inside the trim range, re-based to the start of the exported clip. */
export function toClipMarkers(
  markers: Marker[],
  draft: Pick<Draft, 'epoch' | 'startMs'>,
  trimStartMs: number,
  trimEndMs: number,
): ClipMarker[] {
  const from = draft.startMs + trimStartMs;
  const to = draft.startMs + trimEndMs;
  return markers
    .filter((m) => m.epoch === draft.epoch && m.sourceTimeMs >= from && m.sourceTimeMs <= to)
    .sort((a, b) => a.sourceTimeMs - b.sourceTimeMs)
    .map((m) => ({ id: m.id, type: m.type, timeMs: m.sourceTimeMs - from, comment: m.comment }));
}

/** `mm:ss.SSS`; minutes are not capped at 59. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}
