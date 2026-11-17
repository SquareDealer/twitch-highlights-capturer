import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { formatTimecode } from '@shared/time';
import type { MarkerType } from '@shared/types';
import { clampTrim, msToPx, pxToMs } from '../timelineMath';

export interface TimelineMarker {
  id: string;
  type: MarkerType;
  /** Position relative to the start of the draft. */
  ms: number;
  comment: string;
}

interface Props {
  durationMs: number;
  trim: { startMs: number; endMs: number };
  markers: TimelineMarker[];
  currentMs: number;
  selectedId: string | null;
  onTrim: (trim: { startMs: number; endMs: number }) => void;
  onMarkerMove: (id: string, ms: number) => void;
  onSeek: (ms: number) => void;
  onMarkerSelect: (id: string) => void;
}

type Drag = { kind: 'start' | 'end' } | { kind: 'marker'; id: string; ms: number } | { kind: 'seek' };

/** Draft timeline: trim handles, draggable markers and a playhead. All positions are in draft-relative ms. */
export function Timeline({ durationMs, trim, markers, currentMs, selectedId, onTrim, onMarkerMove, onSeek, onMarkerSelect }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const pct = (ms: number) => `${(msToPx(ms, 1, durationMs) * 100).toFixed(4)}%`;

  const msAt = (e: ReactPointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    return pxToMs(e.clientX - rect.left, rect.width, durationMs);
  };
  const begin = (e: ReactPointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    track.current!.setPointerCapture(e.pointerId);
    setDrag(d);
  };
  const move = (e: ReactPointerEvent) => {
    if (!drag) return;
    const ms = msAt(e);
    if (drag.kind === 'start') onTrim(clampTrim(Math.min(ms, trim.endMs - 500), trim.endMs, durationMs));
    else if (drag.kind === 'end') onTrim(clampTrim(trim.startMs, Math.max(ms, trim.startMs + 500), durationMs));
    else if (drag.kind === 'marker') setDrag({ ...drag, ms });
    else onSeek(ms);
  };
  const finish = (e: ReactPointerEvent) => {
    if (!drag) return;
    if (track.current!.hasPointerCapture(e.pointerId)) track.current!.releasePointerCapture(e.pointerId);
    if (drag.kind === 'marker') onMarkerMove(drag.id, drag.ms);
    setDrag(null);
  };

  return (
    <div className="timeline">
      <div
        className="timeline__track"
        ref={track}
        onPointerDown={(e) => {
          begin(e, { kind: 'seek' });
          onSeek(msAt(e));
        }}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        <div className="timeline__cut" style={{ left: 0, width: pct(trim.startMs) }} />
        <div className="timeline__cut" style={{ left: pct(trim.endMs), right: 0 }} />
        <div className="timeline__keep" style={{ left: pct(trim.startMs), width: pct(trim.endMs - trim.startMs) }} />
        <div className="timeline__handle" style={{ left: pct(trim.startMs) }} onPointerDown={(e) => begin(e, { kind: 'start' })} title="Начало клипа" />
        <div className="timeline__handle timeline__handle--end" style={{ left: pct(trim.endMs) }} onPointerDown={(e) => begin(e, { kind: 'end' })} title="Конец клипа" />
        {markers.map((m) => {
          const ms = drag?.kind === 'marker' && drag.id === m.id ? drag.ms : m.ms;
          const outside = ms < trim.startMs || ms > trim.endMs;
          return (
            <div
              key={m.id}
              className={`timeline__marker${outside ? ' timeline__marker--outside' : ''}${selectedId === m.id ? ' timeline__marker--selected' : ''}`}
              style={{ left: pct(ms) }}
              title={`${m.type} · ${formatTimecode(ms)}${m.comment ? ` · ${m.comment}` : ''}`}
              onPointerDown={(e) => {
                onMarkerSelect(m.id);
                begin(e, { kind: 'marker', id: m.id, ms: m.ms });
              }}
            >
              <span>{m.type}</span>
            </div>
          );
        })}
        <div className="timeline__playhead" style={{ left: pct(currentMs) }} />
      </div>
      <div className="timeline__scale">
        <span>{formatTimecode(0)}</span>
        <span>
          Клип: {formatTimecode(trim.startMs)} – {formatTimecode(trim.endMs)} ({formatTimecode(trim.endMs - trim.startMs)})
        </span>
        <span>{formatTimecode(durationMs)}</span>
      </div>
    </div>
  );
}
