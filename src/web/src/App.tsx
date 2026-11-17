import { useEffect, useRef, useState } from 'react';
import { Notices } from './components/Notices';
import { installHotkeys } from './hotkeys';
import { AppStoreProvider, useAppStore, type View } from './store';
import { EditorView } from './views/EditorView';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';
import { WatchView } from './views/WatchView';

const TABS: Array<{ view: View; label: string }> = [
  { view: 'watch', label: 'Просмотр' },
  { view: 'editor', label: 'Редактор' },
  { view: 'library', label: 'Библиотека' },
  { view: 'settings', label: 'Настройки' },
];

function Shell() {
  const { state, dispatch } = useAppStore();

  const [online, setOnline] = useState(true);

  useEffect(() => {
    const thr = window.thr;
    const load = () => {
      void thr.capture.status().then((status) => dispatch({ type: 'status', status }));
      void thr.moment.active().then((moment) => dispatch({ type: 'moment', moment }));
    };
    load();
    const off = [
      thr.on('capture:status', (status) => dispatch({ type: 'status', status })),
      thr.on('moment:changed', (moment) => dispatch({ type: 'moment', moment })),
      thr.on('marker:prompt', (marker) => dispatch({ type: 'prompt', marker })),
      thr.on('notice', (notice) => dispatch({ type: 'notice', notice })),
      thr.on('nav', (nav) => dispatch({ type: 'view', view: nav.view, draftId: nav.draftId ?? null })),
    ];
    // After the backend restarts, the event stream reconnects by itself; the snapshot is reloaded.
    const onConnection = (e: Event) => {
      const connected = (e as CustomEvent<boolean>).detail;
      setOnline(connected);
      if (connected) load();
    };
    window.addEventListener('thr:connection', onConnection);
    return () => {
      off.forEach((f) => f());
      window.removeEventListener('thr:connection', onConnection);
    };
  }, [dispatch]);

  // Hotkeys are resolved in the page: it knows the current screen and whether a text field has focus.
  const view = useRef(state.view);
  view.current = state.view;
  useEffect(() => installHotkeys(() => (view.current === 'watch' ? 'watch' : view.current === 'editor' ? 'editor' : 'other')), []);

  return (
    <div className="app">
      <nav className="tabs">
        <span className="tabs__brand">Twitch Highlight Recorder</span>
        {TABS.map((t) => (
          <button key={t.view} className={`tab${state.view === t.view ? ' tab--active' : ''}`} onClick={() => dispatch({ type: 'view', view: t.view, draftId: state.editorDraftId })}>
            {t.label}
          </button>
        ))}
      </nav>
      {!online && <div className="offline">Нет связи с приложением. Проверьте, что окно терминала с ним открыто, — страница переподключится сама.</div>}
      <main className="content">
        {/* The watch view stays mounted so the stream keeps playing while other screens are open. */}
        <div className="pane" hidden={state.view !== 'watch'}>
          <WatchView />
        </div>
        {state.view === 'editor' && <div className="pane"><EditorView /></div>}
        {state.view === 'library' && <div className="pane pane--scroll"><LibraryView /></div>}
        {state.view === 'settings' && <div className="pane pane--scroll"><SettingsView /></div>}
      </main>
      <Notices />
    </div>
  );
}

export function App() {
  return (
    <AppStoreProvider>
      <Shell />
    </AppStoreProvider>
  );
}
