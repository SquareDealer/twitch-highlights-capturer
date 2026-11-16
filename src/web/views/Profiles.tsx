import { useState } from 'react';
import type { Profile } from '../../service/profiles';
import type { StreamStatus } from '../../service/streams';
import { api } from '../api';
import { ProfileEditor } from '../components/ProfileEditor';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Profiles({ profiles, streams }: { profiles: Profile[]; streams: StreamStatus[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyName, setCopyName] = useState('');
  const [error, setError] = useState('');
  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0];
  const channelsOf = (p: Profile) => streams.filter((s) => s.profile.id === p.id).map((s) => s.channel);

  const create = async () => {
    if (!selected) return;
    setError('');
    try {
      const p = await api.createProfile(copyName.trim(), selected.id);
      setCopyName('');
      setSelectedId(p.id);
    } catch (e) {
      setError(message(e));
    }
  };

  const remove = async (p: Profile) => {
    if (!confirm(`Удалить профиль «${p.name}»?`)) return;
    setError('');
    try {
      await api.deleteProfile(p.id);
      setSelectedId(null);
    } catch (e) {
      setError(message(e));
    }
  };

  const inUse = selected ? channelsOf(selected).length > 0 : false;

  return (
    <section className="profiles">
      <aside className="profile-list">
        {profiles.map((p) => {
          const channels = channelsOf(p);
          return (
            <button key={p.id} className={p.id === selected?.id ? 'profile-item on' : 'profile-item'} onClick={() => setSelectedId(p.id)}>
              <span>{p.name}</span>
              {p.isDefault && <span className="badge">по умолчанию</span>}
              {channels.length > 0 && <span className="muted">{channels.join(', ')}</span>}
            </button>
          );
        })}
        {selected && (
          <div className="card form">
            <input type="text" placeholder="Название копии" aria-label="Название копии" value={copyName} onChange={(e) => setCopyName(e.target.value)} />
            <div className="row">
              <button disabled={!copyName.trim()} onClick={() => void create()}>Создать</button>
            </div>
            <div className="muted">Копия выбранного профиля «{selected.name}»</div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </aside>
      {selected && (
        <div className="profile-main">
          {!selected.isDefault && (
            <div className="row">
              <button
                className="danger-btn"
                disabled={inUse}
                title={inUse ? 'Профиль используется идущим эфиром' : undefined}
                onClick={() => void remove(selected)}
              >
                Удалить
              </button>
            </div>
          )}
          <ProfileEditor profile={selected} streams={streams} />
        </div>
      )}
    </section>
  );
}
