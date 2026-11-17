/** Pixel offset inside a track of `widthPx` → time, clamped to [0, durationMs]. */
export function pxToMs(px: number, widthPx: number, durationMs: number): number {
  if (widthPx <= 0 || durationMs <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, px / widthPx)) * durationMs);
}

export function msToPx(ms: number, widthPx: number, durationMs: number): number {
  if (widthPx <= 0 || durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, ms / durationMs)) * widthPx;
}

/** Keeps the trim range inside the draft and at least `minMs` long (when the draft itself allows it). */
export function clampTrim(startMs: number, endMs: number, durationMs: number, minMs = 500): { startMs: number; endMs: number } {
  const clamp = (v: number) => Math.min(durationMs, Math.max(0, Math.round(v)));
  let start = clamp(startMs);
  let end = clamp(endMs);
  if (end - start < minMs) start = Math.max(0, end - minMs);
  if (end - start < minMs) end = Math.min(durationMs, start + minMs);
  return { startMs: start, endMs: end };
}
