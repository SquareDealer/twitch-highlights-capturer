import { useState } from 'react';
import type { StreamStatus } from '../../service/streams';
import { api, type CuttingState } from '../api';
import { StreamCard } from '../components/StreamCard';

const MULTI_WARNING =
  'Режим «несколько эфиров» записывает до 5 эфиров одновременно и заметно сильнее нагружает процессор, диск и сеть. Включить?';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Streams({
  streams,
  multiStream,
  cutting,
  onMode,
}: {
  streams: StreamStatus[];
  multiStream: boolean;
  cutting: CuttingState;
  onMode: (multiStream: boolean) => void;
}) {
  const [url, setUrl] = useState('');
  const [qualities, setQualities] = useState<string[] | null>(null);
  const [quality, setQuality] = useState('best');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const probe = async () => {
    setBusy(true);
    setError('');
    setQualities(null);
    try {
      const r = await api.probe(url.trim());
      setQualities(r.qualities);
      setQuality(r.qualities.includes('best') ? 'best' : (r.qualities[0] ?? 'best'));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await api.startStream(url.trim(), quality);
      setUrl('');
      setQualities(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleMode = async (next: boolean) => {
    if (next && !confirm(MULTI_WARNING)) return;
    setError('');
    try {
      onMode((await api.setMode(next)).multiStream);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <section>
      {cutting.paused && <div className="banner">{cutting.reason ?? 'Нарезка клипов приостановлена'}</div>}
      <div className="card form">
        <div className="row">
          <input
            type="url"
            placeholder="Ссылка на канал Twitch"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setQualities(null);
            }}
          />
          <button disabled={busy || !url.trim()} onClick={probe}>Проверить</button>
        </div>
        {qualities && (
          <div className="row">
            <select value={quality} onChange={(e) => setQuality(e.target.value)} aria-label="Качество">
              {qualities.map((q) => (
                <option key={q} value={q}>{q}</option>
              ))}
            </select>
            <button className="primary" disabled={busy} onClick={start}>Начать</button>
          </div>
        )}
        <label className="switch">
          <input type="checkbox" checked={multiStream} onChange={(e) => toggleMode(e.target.checked)} />
          Несколько эфиров
        </label>
        {error && <div className="error">{error}</div>}
      </div>
      {streams.length === 0 ? <p className="muted empty">Сейчас ничего не записывается</p> : streams.map((s) => <StreamCard key={s.id} stream={s} />)}
    </section>
  );
}
