import { useCallback, useEffect, useState } from 'react';
import type { FeedClip } from '../service/types';
import type { StreamStatus } from '../service/streams';
import { api, ApiError, subscribe, type CuttingState, type Notice } from './api';
import { Feed } from './views/Feed';
import { Login } from './views/Login';
import { Streams } from './views/Streams';

type Clip = Omit<FeedClip, 'mp4Path' | 'jsonPath'>;
type Screen = 'checking' | 'login' | 'streams' | 'feed';

const upsert = (list: Clip[], c: Clip): Clip[] => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list]);

export function App() {
  const [screen, setScreen] = useState<Screen>('checking');
  const [streams, setStreams] = useState<StreamStatus[]>([]);
  const [multi, setMulti] = useState(false);
  const [cutting, setCutting] = useState<CuttingState>({ paused: false, reason: null });
  const [clips, setClips] = useState<Clip[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const authed = screen === 'streams' || screen === 'feed';

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setStreams(s.streams);
      setMulti(s.mode.multiStream);
      setCutting(s.cutting);
      setClips(await api.clips({ limit: 200 }));
      setScreen((cur) => (cur === 'feed' ? cur : 'streams'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setScreen('login');
      else setNotice({ level: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!authed) return;
    return subscribe({
      streams: setStreams,
      clip: (c) => setClips((l) => upsert(l, c)),
      notice: setNotice,
      cutting: setCutting,
      unauthorized: () => setScreen('login'),
    });
  }, [authed]);

  if (screen === 'checking') return null;
  if (screen === 'login') return <Login onLogin={() => void load()} />;

  return (
    <div className="app">
      <header>
        <nav>
          <button className={screen === 'streams' ? 'tab on' : 'tab'} onClick={() => setScreen('streams')}>Эфиры</button>
          <button className={screen === 'feed' ? 'tab on' : 'tab'} onClick={() => setScreen('feed')}>Лента</button>
        </nav>
        <button className="link" onClick={() => api.logout().finally(() => setScreen('login'))}>Выйти</button>
      </header>
      {notice && (
        <div className={`notice ${notice.level}`} onClick={() => setNotice(null)}>{notice.message}</div>
      )}
      {screen === 'streams' ? (
        <Streams streams={streams} multiStream={multi} cutting={cutting} onMode={setMulti} />
      ) : (
        <Feed clips={clips} onChange={(c) => setClips((l) => upsert(l, c))} />
      )}
    </div>
  );
}
