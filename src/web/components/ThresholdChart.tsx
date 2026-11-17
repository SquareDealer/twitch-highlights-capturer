import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fromDisplay, toDisplay, type FieldDef } from '../../service/profileSettings';
import { num } from '../format';
import { clampField, parseNumber } from '../tuning';

const W = 300;
const H = 72;

/** The field's unit as it follows a number: «×» goes in front, the rest behind. */
export function withUnit(def: FieldDef, stored: number): string {
  const shown = num(toDisplay(def, stored), 2);
  if (def.unit === '×') return `×${shown}`;
  return def.unit === '—' ? shown : `${shown} ${def.unit}`;
}

/**
 * A line chart of the last minutes with a threshold the user drags (pointer or arrow keys) or types.
 * Values and thresholds are in stored units; `def` gives bounds, step and the display unit.
 * `min`/`max` narrow the field's own range (limits that come from other settings).
 */
export function ThresholdChart({ label, values, marks, threshold, savedThreshold, secondary, def, min, max, onChange }: {
  label: string; values: number[]; marks: number[];
  threshold: number; savedThreshold: number; secondary?: { value: number; label: string };
  def: FieldDef; min?: number; max?: number;
  onChange(stored: number): void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState(() => num(toDisplay(def, threshold), 4));

  const lo = Math.max(def.min, min ?? def.min);
  const hi = Math.min(def.max, max ?? def.max);
  const within = (v: number) => Math.min(hi, Math.max(lo, v));
  /** For the line, the arrows and the buttons: on the step grid. A typed number keeps its own precision. */
  const fit = (v: number) => within(clampField(def, v));

  // The input keeps what the user typed while it still means the current threshold ('2,' stays '2,').
  useEffect(() => {
    const typed = parseNumber(text);
    if (typed === null || fromDisplay(def, typed) !== threshold) setText(num(toDisplay(def, threshold), 4));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold, def]);

  const clean = values.map((v) => (Number.isFinite(v) ? v : 0));
  // One huge value (the burst while the baseline is still empty) must not flatten the rest: the scale grows
  // with the data only up to twice the slider range; higher points are clipped at the top edge.
  const top = Math.max(def.sliderMax, threshold, savedThreshold, Math.min(def.sliderMax * 2, Math.max(0, ...clean))) || 1;
  const y = (v: number) => H - Math.max(0, Math.min(1, v / top)) * H;
  const step = clean.length > 1 ? W / (clean.length - 1) : 0;
  const x = (i: number) => (clean.length > 1 ? i * step : W / 2);
  const points = clean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const fromPointer = (e: PointerEvent) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    onChange(fit((1 - (e.clientY - rect.top) / rect.height) * top));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    onChange(fit(threshold + dir * def.step));
  };
  // While typing, only a number already inside the range is taken: «1» on the way to «1,8» must not be
  // rewritten to the lower bound under the user's fingers. Blur or Enter fits whatever was typed.
  const typedValue = (value: string): number | null => {
    const typed = parseNumber(value);
    return typed === null ? null : fromDisplay(def, typed);
  };
  const onText = (value: string) => {
    setText(value);
    const v = typedValue(value);
    if (v !== null && v >= lo && v <= hi) onChange(v);
  };
  const commitText = () => {
    const v = typedValue(text);
    const next = v === null ? threshold : within(v);
    if (next !== threshold) onChange(next);
    setText(num(toDisplay(def, next), 4));
  };

  return (
    <div className="tchart">
      <div className="tchart-head">
        <span className="muted">{label}, 5 минут</span>
        <span className="tchart-controls">
          <button type="button" aria-label={`${label}: меньше`} onClick={() => onChange(fit(threshold - def.step))}>−</button>
          <input
            type="text" inputMode="decimal" aria-label={`${label}: значение порога`}
            value={text} onChange={(e) => onText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => { if (e.key === 'Enter') commitText(); }}
          />
          <span className="muted unit">{def.unit}</span>
          <button type="button" aria-label={`${label}: больше`} onClick={() => onChange(fit(threshold + def.step))}>+</button>
        </span>
      </div>
      <svg ref={svg} className={`tchart-plot${dragging ? ' dragging' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {marks.filter((i) => i >= 0 && i < clean.length).map((i) => (
          <line key={i} className="mark" x1={x(i)} x2={x(i)} y1={0} y2={H} />
        ))}
        {secondary && <line className="secondary" x1="0" x2={W} y1={y(secondary.value)} y2={y(secondary.value)} />}
        {clean.length > 0 && <polyline className="line" fill="none" points={points} />}
        {savedThreshold !== threshold && <line className="saved" x1="0" x2={W} y1={y(savedThreshold)} y2={y(savedThreshold)} />}
        <g
          className="handle" role="slider" tabIndex={0}
          aria-label={`${label}: порог`} aria-orientation="vertical"
          aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={threshold} aria-valuetext={withUnit(def, threshold)}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDragging(true); fromPointer(e); }}
          onPointerMove={(e) => { if (dragging) fromPointer(e); }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <line className="grab" x1="0" x2={W} y1={y(threshold)} y2={y(threshold)} />
          <line className="threshold" x1="0" x2={W} y1={y(threshold)} y2={y(threshold)} />
        </g>
      </svg>
      <div className="tchart-legend muted">
        <span><i className="key k-threshold" /> порог {withUnit(def, threshold)} — тяните линию</span>
        {secondary && <span><i className="key k-secondary" /> {secondary.label} {withUnit(def, secondary.value)}</span>}
        {marks.length > 0 && <span><i className="key k-mark" /> сработало бы</span>}
      </div>
    </div>
  );
}
