import { useEffect, useRef, useState } from 'react';
import { formatTimecode } from '@shared/time';
import type { Marker } from '@shared/types';

interface Props {
  marker: Marker | null;
  onSubmit: (id: string, comment: string) => void;
  onCancel: (id: string) => void;
}

/**
 * Small comment field shown over the player right after a digit key.
 * The marker already exists with its time fixed; Enter only attaches the (possibly empty) comment.
 */
export function MarkerPrompt({ marker, onSubmit, onCancel }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<{ id: string | null; text: string }>({ id: null, text: '' });
  previous.current.text = text;

  useEffect(() => {
    const prev = previous.current;
    // A new digit arrived while the field was open: keep what was typed for the earlier marker.
    if (prev.id && marker && prev.id !== marker.id && prev.text.trim()) onSubmit(prev.id, prev.text);
    prev.id = marker?.id ?? null;
    setText('');
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker?.id]);

  if (!marker) return null;
  return (
    <div className="marker-prompt" role="dialog" aria-label="Новый маркер">
      <div className="marker-prompt__head">
        <span className="marker-badge" data-testid="marker-type">{marker.type}</span>
        <div>
          <div className="marker-prompt__title">Новый маркер</div>
          <div className="marker-prompt__time">{formatTimecode(marker.sourceTimeMs)}</div>
        </div>
      </div>
      <input
        ref={input}
        autoFocus
        className="input"
        maxLength={500}
        placeholder="Комментарий к моменту…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(marker.id, text);
            setText('');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel(marker.id);
            setText('');
          }
        }}
      />
      <div className="marker-prompt__hint">Enter — сохранить без комментария</div>
      <div className="marker-prompt__hint">Esc — удалить маркер</div>
    </div>
  );
}
