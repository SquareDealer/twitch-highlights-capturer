import { useState } from 'react';
import { checkField, fromDisplay, toDisplay, type FieldDef } from '../../service/profileSettings';
import { num } from '../format';
import { parseNumber } from '../tuning';

const APPLIES = { now: 'со следующей секунды', window: 'по мере набора данных' } as const;

/** Unit as shown next to the input: display conversions bring their own. */
export const unitOf = (def: FieldDef): string => (def.display === 'seconds' ? 'с' : def.display === 'percent' ? '%' : def.unit);

/**
 * One numeric setting: a slider over the working range and a text input for the whole allowed range.
 * `value` is the text of the input, in display units (percent, seconds); `factory` is the stored factory value.
 */
export function NumberField({ def, value, factory, error, onChange }: {
  def: FieldDef; value: string; factory: number; error?: string; onChange(text: string): void;
}) {
  const [hint, setHint] = useState(false);
  const id = `pf-${def.path}`;
  const unit = unitOf(def);
  const parsed = parseNumber(value);
  const stored = parsed === null ? null : fromDisplay(def, parsed);
  const shown = (v: number) => num(toDisplay(def, v), 6);
  const differs = stored !== null && stored !== factory;
  const problem = error || (stored === null ? null : checkField(def, stored));
  const sliderMin = toDisplay(def, def.sliderMin);
  const sliderMax = toDisplay(def, def.sliderMax);

  return (
    <div className="field nf">
      <div className="nf-head">
        <label htmlFor={id}>{def.label}</label>
        <button type="button" className="hint-btn" aria-label={`Подсказка: ${def.label}`} aria-expanded={hint} onClick={() => setHint((v) => !v)}>?</button>
        {differs && (
          <>
            <span className="dot" title="отличается от заводского значения" />
            <button type="button" className="link" onClick={() => onChange(shown(factory))}>
              вернуть {shown(factory)}{unit === '—' ? '' : ` ${unit}`}
            </button>
          </>
        )}
      </div>
      <div className="nf-row">
        <input
          type="range" aria-label={`${def.label}: ползунок`}
          min={sliderMin} max={sliderMax} step={toDisplay(def, def.step)}
          value={parsed === null ? sliderMin : Math.min(sliderMax, Math.max(sliderMin, parsed))}
          onChange={(e) => onChange(num(Number(e.target.value), 6))}
        />
        <input id={id} type="text" inputMode="decimal" value={value} aria-invalid={problem ? true : undefined} onChange={(e) => onChange(e.target.value)} />
        <span className="muted unit">{unit}</span>
      </div>
      {hint && <div className="muted hint">{def.hint} ({APPLIES[def.applies]})</div>}
      {problem && <div className="error">{problem}</div>}
    </div>
  );
}
