import { useMemo, useState } from 'react';
import type { ClipStatus, FeedClip } from '../../service/types';
import { ClipCard } from '../components/ClipCard';

type Clip = Omit<FeedClip, 'mp4Path' | 'jsonPath'>;

export function Feed({ clips, onChange }: { clips: Clip[]; onChange: (c: FeedClip) => void }) {
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState<'' | ClipStatus>('');
  const [sort, setSort] = useState<'time' | 'score'>('time');

  const channels = useMemo(() => [...new Set(clips.map((c) => c.streamer))].sort(), [clips]);
  const shown = useMemo(() => {
    const list = clips.filter((c) => (!channel || c.streamer === channel) && (!status || c.status === status));
    return list.sort((a, b) => (sort === 'score' ? b.score - a.score : b.createdAt.localeCompare(a.createdAt)));
  }, [clips, channel, status, sort]);

  return (
    <section>
      <div className="row filters">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Канал">
          <option value="">Все каналы</option>
          {channels.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as '' | ClipStatus)} aria-label="Статус">
          <option value="">Все</option>
          <option value="new">Новые</option>
          <option value="taken">Взятые</option>
          <option value="rejected">Отклонённые</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'time' | 'score')} aria-label="Сортировка">
          <option value="time">По времени</option>
          <option value="score">По оценке</option>
        </select>
      </div>
      {shown.length === 0 ? <p className="muted empty">Клипов пока нет</p> : shown.map((c) => <ClipCard key={c.id} clip={c} onChange={onChange} />)}
    </section>
  );
}
