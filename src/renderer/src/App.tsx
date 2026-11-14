import { useEffect } from 'react';
import { Notices } from './components/Notices';
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

const isTextInput = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);

function Shell() {
  const { state, dispatch } = useAppStore();

  useEffect(() => {
    const thr = window.thr;
    void thr.capture.status().then((status) => dispatch({ type: 'status', status }));
    void thr.moment.active().then((moment) => dispatch({ type: 'moment', moment }));
    const off = [
      thr.on('capture:status', (status) => dispatch({ type: 'status', status })),
      thr.on('moment:changed', (moment) => dispatch({ type: 'moment', moment })),
      thr.on('marker:prompt', (marker) => dispatch({ type: 'prompt', marker })),
      thr.on('notice', (notice) => dispatch({ type: 'notice', notice })),
      thr.on('nav', (nav) => dispatch({ type: 'view', view: nav.view, draftId: nav.draftId ?? null })),
    ];
    return () => off.forEach((f) => f());
  }, [dispatch]);

  // The main process decides which hotkeys apply from the current screen and whether a text field has focus.
  useEffect(() => {
    const mode = state.view === 'watch' ? 'watch' : state.view === 'editor' ? 'editor' : 'other';
    const report = () => void window.thr.ui.setState({ mode, textInputFocused: isTextInput(document.activeElement) });
    report();
    const deferred = () => setTimeout(report, 0); // focusout fires before the next element is focused
    document.addEventListener('focusin', report);
    document.addEventListener('focusout', deferred);
    return () => {
      document.removeEventListener('focusin', report);
      document.removeEventListener('focusout', deferred);
    };
  }, [state.view, state.prompt?.id]);

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
