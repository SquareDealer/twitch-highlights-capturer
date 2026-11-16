import { useState } from 'react';
import type { Profile } from '../../service/profiles';
import type { StreamStatus } from '../../service/streams';
import type { TuningEntry } from '../../service/tuningLog';
import { api } from '../api';
import { storeTuning, tuningStored } from '../tuning';
import { TuningPanel } from './TuningPanel';

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

export function StreamCard({ stream, profiles, liveEntries }: { stream: StreamStatus; profiles: Profile[]; liveEntries: TuningEntry[] }) {
  const [tuning, setTuning] = useState(() => tuningStored(stream.channel));
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
        <select
          aria-label="Профиль"
          value={stream.profile.id}
          disabled={busy}
          onChange={(e) => void run(() => api.setStreamProfile(stream.id, e.target.value))}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {stream.profileApplied < stream.profileVersion && <span className="muted">применяется…</span>}
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
        <label className="switch">
          <input
            type="checkbox"
            checked={tuning}
            onChange={(e) => {
              setTuning(e.target.checked);
              storeTuning(stream.channel, e.target.checked);
            }}
          />
          Настройка
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      {tuning && <TuningPanel stream={stream} profile={profiles.find((x) => x.id === stream.profile.id)} liveEntries={liveEntries} />}
    </article>
  );
}
