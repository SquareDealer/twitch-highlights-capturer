import { useState } from 'react';

/** A dictionary as chips: one pattern per chip, added with Enter, removed with ×. */
export function PatternChips({ label, patterns, bad, error, onChange }: {
  label: string; patterns: string[]; bad: string[]; error?: string; onChange(next: string[]): void;
}) {
  const [text, setText] = useState('');

  const add = () => {
    const p = text.trim();
    if (p === '' || patterns.includes(p)) return;
    onChange([...patterns, p]);
    setText('');
  };

  return (
    <div className="field" role="group" aria-label={label}>
      <div className="nf-head"><span>{label}</span> <span className="muted">{patterns.length}</span></div>
      <div className="chips">
        {patterns.map((p) => {
          const unused = bad.includes(p);
          return (
            <span key={p} className={unused ? 'chip bad' : 'chip'} title={unused ? 'не используется детектором' : undefined}>
              <code>{p}</code>
              <button type="button" aria-label={`Удалить ${p}`} onClick={() => onChange(patterns.filter((x) => x !== p))}>×</button>
            </span>
          );
        })}
        <input
          type="text" className="chip-input" placeholder="шаблон и Enter" aria-label={`${label}: добавить шаблон`}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation(); // Enter here adds a chip; it must not save the profile
            add();
          }}
        />
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
