import { useEffect, useState } from 'react';
import { MarkerPrompt } from '../components/MarkerPrompt';
import { StatusBar } from '../components/StatusBar';
import { TwitchPlayer } from '../components/TwitchPlayer';
import { useAppStore } from '../store';

export function WatchView() {
  const { state, dispatch } = useAppStore();
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const session = state.status.session;
  const watching = session !== null && session.state !== 'ERROR' && session.state !== 'STOPPING';

  useEffect(() => {
    void window.thr.settings.get().then((s) => setChannel((current) => current || s.lastChannel));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      dispatch({ type: 'notice', notice: { level: 'error', message: (e as Error).message } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="watch">
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (channel.trim()) void run(() => window.thr.capture.start(channel));
        }}
      >
        <input className="input toolbar__channel" placeholder="Канал Twitch или ссылка" value={channel} onChange={(e) => setChannel(e.target.value)} spellCheck={false} />
        <button className="button button--primary" type="submit" disabled={busy || !channel.trim()}>
          Смотреть
        </button>
        <button className="button" type="button" disabled={busy || !session} onClick={() => void run(() => window.thr.capture.stop())}>
          Стоп
        </button>
        {state.status.markerCount > 0 && (
          <button
            className="button button--ghost"
            type="button"
            onClick={() => {
              if (window.confirm('Удалить все несохранённые маркеры?')) void window.thr.moment.discardActive();
            }}
          >
            Сбросить маркеры
          </button>
        )}
      </form>

      <div className="stage">
        {watching ? (
          <TwitchPlayer
            channel={session.streamer}
            onLatency={(ms) => void window.thr.player.reportLatency(ms)}
            onError={(message) => dispatch({ type: 'notice', notice: { level: 'error', message } })}
          />
        ) : (
          <div className="stage__empty">
            <h2>Twitch Highlight Recorder</h2>
            <p>Введите канал и нажмите «Смотреть». Запись в буфер начнётся автоматически.</p>
            {session?.state === 'ERROR' && <p className="stage__error">{session.error}</p>}
          </div>
        )}
        <MarkerPrompt
          marker={state.prompt}
          onSubmit={(id, comment) => {
            void window.thr.markers.setComment(id, comment);
            dispatch({ type: 'prompt', marker: null });
          }}
          onCancel={(id) => {
            void window.thr.markers.remove(id);
            dispatch({ type: 'prompt', marker: null });
          }}
        />
      </div>

      <StatusBar status={state.status} />
    </div>
  );
}
