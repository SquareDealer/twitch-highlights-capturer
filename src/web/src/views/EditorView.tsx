import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTimecode } from '@shared/time';
import type { Marker, MarkerType, OpenedDraft } from '@shared/types';
import { Timeline, type TimelineMarker } from '../components/Timeline';
import { useAppStore } from '../store';
import { clampTrim } from '../timelineMath';

const FRAME_MS = 1000 / 30;
const EXTEND_MS = 30_000;
const TYPES: MarkerType[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function EditorView() {
  const { state, dispatch } = useAppStore();
  const [opened, setOpened] = useState<OpenedDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [trim, setTrim] = useState({ startMs: 0, endMs: 0 });
  const [title, setTitle] = useState('');
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const saving = useRef(false);
  const loadedDraft = useRef<{ id: string; startMs: number; endMs: number } | null>(null);
  const trimRef = useRef(trim);
  trimRef.current = trim;

  const notify = useCallback((level: 'info' | 'warn' | 'error', message: string) => dispatch({ type: 'notice', notice: { level, message } }), [dispatch]);

  const load = useCallback(
    async (draftId: string | null) => {
      const next = await window.thr.drafts.open(draftId);
      const prev = loadedDraft.current;
      if (next) {
        const length = next.draft.endMs - next.draft.startMs;
        if (!prev || prev.id !== next.draft.id) {
          setTrim({ startMs: 0, endMs: length });
          setTitle(next.moment.markers.find((m) => m.comment)?.comment ?? '');
          setCurrentMs(0);
          setSelectedId(null);
        } else if (prev.startMs !== next.draft.startMs || prev.endMs !== next.draft.endMs) {
          // The draft was extended: keep the trim on the same footage.
          const shift = prev.startMs - next.draft.startMs;
          setTrim((t) => clampTrim(t.startMs + shift, t.endMs + shift, length));
        }
        loadedDraft.current = { id: next.draft.id, startMs: next.draft.startMs, endMs: next.draft.endMs };
      } else {
        loadedDraft.current = null;
      }
      setOpened(next);
      setLoaded(true);
    },
    [],
  );

  useEffect(() => {
    void load(state.editorDraftId);
  }, [state.editorDraftId, load]);

  // Markers can change underneath us (drag, comment edit, a new marker from the watch screen).
  useEffect(() => {
    const refresh = () => void load(loadedDraft.current?.id ?? state.editorDraftId);
    const off = [window.thr.on('moment:changed', refresh), window.thr.on('drafts:changed', refresh)];
    return () => off.forEach((f) => f());
  }, [load, state.editorDraftId]);

  const draft = opened?.draft ?? null;
  const durationMs = draft ? draft.endMs - draft.startMs : 0;

  const save = useCallback(async () => {
    if (!draft || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const t = trimRef.current;
      const result = await window.thr.clips.export({ draftId: draft.id, trimStartMs: t.startMs, trimEndMs: t.endMs, title });
      if (result.ok) {
        notify('info', 'Клип сохраняется…');
        loadedDraft.current = null;
        dispatch({ type: 'view', view: 'watch' });
      } else {
        notify('error', result.error);
      }
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [draft, title, notify, dispatch]);

  useEffect(() => window.thr.on('editor:save', () => void save()), [save]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.min(durationMs, Math.max(0, ms));
      setCurrentMs(clamped);
      if (video.current) video.current.currentTime = clamped / 1000;
    },
    [durationMs],
  );

  // Smooth playhead and looping inside the trim range.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        const t = trimRef.current;
        if (v.currentTime * 1000 >= t.endMs || v.ended) v.currentTime = t.startMs / 1000;
        setCurrentMs(v.currentTime * 1000);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (currentMs < trim.startMs || currentMs >= trim.endMs) v.currentTime = trim.startMs / 1000;
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  };

  const { inside, outside } = useMemo(() => {
    const all: Marker[] = opened?.moment.markers ?? [];
    const isInside = (m: Marker) => draft !== null && m.epoch === draft.epoch && m.sourceTimeMs >= draft.startMs && m.sourceTimeMs <= draft.endMs;
    return { inside: all.filter(isInside), outside: all.filter((m) => !isInside(m)) };
  }, [opened, draft]);

  if (!loaded) return null;
  if (!opened || !draft) {
    return (
      <div className="empty">
        <h2>Черновиков нет</h2>
        <p>Нажмите F8 во время просмотра, чтобы сохранить повтор из буфера.</p>
      </div>
    );
  }

  const timelineMarkers: TimelineMarker[] = inside.map((m) => ({ id: m.id, type: m.type, ms: m.sourceTimeMs - draft.startMs, comment: m.comment }));
  const extend = async (by: { beforeMs: number; afterMs: number }) => {
    setBusy(true);
    try {
      const before = draft;
      const next = await window.thr.drafts.extend(draft.id, by);
      if (next.startMs === before.startMs && next.endMs === before.endMs) notify('warn', 'В буфере больше нет записи для расширения');
      await load(draft.id);
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <div className="editor__main">
        <video
          key={opened.mediaUrl}
          ref={video}
          className="editor__video"
          src={opened.mediaUrl}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={() => seek(Math.max(currentMs, trim.startMs))}
          onClick={togglePlay}
        />
        <div className="editor__transport">
          <button className="button" onClick={togglePlay}>{playing ? 'Пауза' : 'Играть'}</button>
          <button className="button button--small" onClick={() => seek(currentMs - 1000)}>−1 с</button>
          <button className="button button--small" onClick={() => seek(currentMs - FRAME_MS)}>−1 кадр</button>
          <span className="editor__time">{formatTimecode(currentMs)}</span>
          <button className="button button--small" onClick={() => seek(currentMs + FRAME_MS)}>+1 кадр</button>
          <button className="button button--small" onClick={() => seek(currentMs + 1000)}>+1 с</button>
          <span className="statusbar__spacer" />
          <button className="button button--small" onClick={() => setTrim(clampTrim(currentMs, trim.endMs, durationMs))} title="Начать клип с текущей позиции">Начало здесь</button>
          <button className="button button--small" onClick={() => setTrim(clampTrim(trim.startMs, currentMs, durationMs))} title="Закончить клип на текущей позиции">Конец здесь</button>
        </div>
        <Timeline
          durationMs={durationMs}
          trim={trim}
          markers={timelineMarkers}
          currentMs={currentMs}
          selectedId={selectedId}
          onTrim={setTrim}
          onSeek={seek}
          onMarkerSelect={setSelectedId}
          onMarkerMove={(id, ms) => void window.thr.markers.update(id, { sourceTimeMs: draft.startMs + ms })}
        />
        <div className="editor__actions">
          <button className="button button--small" disabled={busy} onClick={() => void extend({ beforeMs: EXTEND_MS, afterMs: 0 })} title="Добавить 30 секунд перед началом черновика">−30 с в начало</button>
          <button className="button button--small" disabled={busy} onClick={() => void extend({ beforeMs: 0, afterMs: EXTEND_MS })} title="Добавить 30 секунд после конца черновика">+30 с в конец</button>
          <span className="statusbar__spacer" />
          <button
            className="button button--danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Удалить черновик? Видео будет потеряно.')) return;
              loadedDraft.current = null;
              void window.thr.drafts.discard(draft.id).then(() => dispatch({ type: 'view', view: 'library' }));
            }}
          >
            Удалить черновик
          </button>
        </div>
      </div>

      <aside className="editor__side">
        <label className="field">
          <span>Название клипа</span>
          <input className="input" value={title} maxLength={200} placeholder="Например: Funny reaction" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <button className="button button--primary" disabled={busy} onClick={() => void save()}>Сохранить (Ctrl+S)</button>

        <h3 className="editor__markers-title">Маркеры</h3>
        {inside.length === 0 && outside.length === 0 && <p className="muted">Маркеров нет. Клип можно сохранить и без них.</p>}
        <ul className="marker-list">
          {inside.map((m) => {
            const rel = m.sourceTimeMs - draft.startMs;
            const inTrim = rel >= trim.startMs && rel <= trim.endMs;
            return (
              <li key={m.id} className={`marker-row${selectedId === m.id ? ' marker-row--selected' : ''}`}>
                <select className="input marker-row__type" value={m.type} onChange={(e) => void window.thr.markers.update(m.id, { type: Number(e.target.value) as MarkerType })}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <button
                  className="marker-row__time"
                  title="Перейти к маркеру"
                  onClick={() => {
                    setSelectedId(m.id);
                    seek(rel);
                  }}
                >
                  {inTrim ? formatTimecode(rel - trim.startMs) : 'не войдёт в клип'}
                </button>
                <CommentInput marker={m} />
                <button className="button button--small" title="Поставить маркер на текущую позицию" onClick={() => void window.thr.markers.update(m.id, { sourceTimeMs: draft.startMs + Math.round(currentMs) })}>⌖</button>
                <button className="button button--small button--danger" title="Удалить маркер" onClick={() => void window.thr.markers.remove(m.id)}>✕</button>
              </li>
            );
          })}
          {outside.map((m) => (
            <li key={m.id} className="marker-row marker-row--outside">
              <span className="marker-badge">{m.type}</span>
              <span className="muted">вне черновика{m.comment ? ` · ${m.comment}` : ''}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function CommentInput({ marker }: { marker: Marker }) {
  const [value, setValue] = useState(marker.comment);
  useEffect(() => setValue(marker.comment), [marker.comment]);
  const commit = () => {
    if (value !== marker.comment) void window.thr.markers.setComment(marker.id, value);
  };
  return (
    <input
      className="input marker-row__comment"
      value={value}
      maxLength={500}
      placeholder="Комментарий"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
