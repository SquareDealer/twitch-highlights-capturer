import { useState } from 'react';
import type { FeedClip } from '../../service/types';
import { api, type PublicClip } from '../api';
import { clipSummary, clockTime, duration, num, triggerLabel } from '../format';

type Decision = 'taken' | 'rejected';
const STATUS_LABEL: Record<FeedClip['status'], string> = {
  pending: 'нарезается',
  new: 'новый',
  taken: 'взят',
  rejected: 'отклонён',
  error: 'ошибка',
};

export function ClipCard({ clip, onChange }: { clip: PublicClip; onChange: (c: PublicClip) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const playable = clip.status !== 'pending' && clip.status !== 'error' && !clip.fileDeleted;
  const decidable = clip.status === 'new' || clip.status === 'taken' || clip.status === 'rejected';
  const src = `/media/clips/${encodeURIComponent(clip.id)}.mp4`;

  const decide = async (d: Decision) => {
    setBusy(true);
    setError('');
    try {
      onChange(await api.setClipStatus(clip.id, clip.status === d ? 'new' : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`card clip clip-${clip.status}`}>
      <div className="clip-media">
        {playable ? (
          <video controls preload="none" src={src} />
        ) : (
          <div className="clip-placeholder">
            {clip.status === 'pending' ? 'нарезается…' : clip.status === 'error' ? clip.error ?? 'Ошибка нарезки' : 'файл удалён'}
          </div>
        )}
      </div>
      <div className="clip-body">
        <div className="clip-head">
          <strong>{clip.streamer}</strong>
          <span className="muted">
            {clockTime(clip.createdAt)} · {duration(clip.durationMs)} · {clip.triggers.map(triggerLabel).join(' + ')}{clip.triggers.includes('manual') ? '' : clip.signals.triggerShare === undefined && clip.score < 1 ? ` · S ${num(clip.score, 2)}` : ` · оценка ${num(clip.score)}`}
          </span>
          {clip.confidence === 'low' && <span className="badge warn">низкая уверенность</span>}
        </div>
        <div className="muted">{clipSummary(clip)}</div>
        <div className="clip-actions">
          {decidable && (
            <>
              <button className={clip.status === 'taken' ? 'on' : ''} disabled={busy} onClick={() => decide('taken')}>Беру</button>
              <button className={clip.status === 'rejected' ? 'on danger' : ''} disabled={busy} onClick={() => decide('rejected')}>Отклонить</button>
            </>
          )}
          {playable && <a className="button" href={`${src}?download=1`}>Скачать</a>}
          <span className="status-label">{STATUS_LABEL[clip.status]}</span>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </article>
  );
}
