import { useEffect } from 'react';
import { useAppStore, type AppNotice } from '../store';

function Toast({ notice }: { notice: AppNotice }) {
  const { dispatch } = useAppStore();
  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: 'dismiss', id: notice.id }), notice.level === 'info' ? 4000 : 8000);
    return () => clearTimeout(timer);
  }, [notice.id, notice.level, dispatch]);
  return (
    <button className={`toast toast--${notice.level}`} onClick={() => dispatch({ type: 'dismiss', id: notice.id })} title="Закрыть">
      {notice.message}
    </button>
  );
}

export function Notices() {
  const { state } = useAppStore();
  return (
    <div className="toasts" aria-live="polite">
      {state.notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </div>
  );
}
