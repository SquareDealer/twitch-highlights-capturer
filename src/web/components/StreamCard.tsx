import { useState } from 'react';
import type { StreamStatus } from '../../service/streams';
import { api } from '../api';

const STATE_LABEL: Record<string, string> = {
  CONNECTING: 'подключение',
  RECORDING: 'запись',
  RECONNECTING: 'переподключение',
  STOPPING: 'остановка',
  IDLE: 'ожидание',
};

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className="meter">
      <span>{label}</span>
      <div className="track">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function StreamCard({ stream }: { stream: StreamStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const stateText = stream.state === 'ERROR' ? stream.error ?? 'ошибка' : STATE_LABEL[stream.state] ?? stream.state;

  const run = async (fn: () => Promise<unknown>, ok = false) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setSaved(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card stream">
      <div className="stream-head">
        <strong>{stream.channel}</strong>
        <span className={`badge ${stream.state === 'ERROR' ? 'bad' : stream.state === 'RECORDING' ? 'ok' : ''}`}>{stateText}</span>
        {!stream.detector.running && <span className="badge warn">детектор не работает</span>}
        {!stream.detector.running && stream.detector.lastError && (
          <span className="muted detector-error" title={stream.detector.lastError}>{stream.detector.lastError}</span>
        )}
        {stream.detector.chat === 'disconnected' && <span className="badge warn">нет чата</span>}
      </div>
      <div className="muted">
        буфер {Math.round(stream.bufferedMs / 1000)} с · клипов {stream.clipsCreated}
      </div>
      <Meter label="чат" value={stream.signals?.chatSpike ?? 0} max={8} />
      <Meter label="звук" value={stream.signals?.deltaDb ?? 0} max={20} />
      <div className="row">
        <button disabled={busy} onClick={() => run(() => api.stopStream(stream.id))}>Остановить</button>
        <button disabled={busy} onClick={() => run(() => api.manualClip(stream.id), true)}>Сохранить последние 60 с</button>
        {saved && <span className="muted">клип поставлен в очередь</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </article>
  );
}
