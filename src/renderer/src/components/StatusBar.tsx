import type { CaptureStatus } from '@shared/types';

const mmss = (ms: number) => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const STATE_LABEL: Record<string, string> = {
  CONNECTING: 'Подключение…',
  RECONNECTING: 'Переподключение…',
  STOPPING: 'Остановка…',
  ERROR: 'Ошибка',
};

export function StatusBar({ status }: { status: CaptureStatus }) {
  const session = status.session;
  const state = session?.state ?? 'IDLE';
  return (
    <div className="statusbar">
      {state === 'RECORDING' ? (
        <span className="badge badge--live">LIVE</span>
      ) : (
        <span className={`badge badge--${state.toLowerCase()}`} title={session?.error}>{STATE_LABEL[state] ?? 'Не в эфире'}</span>
      )}
      {session && <span className="statusbar__name">{session.streamer}</span>}
      <span className="statusbar__spacer" />
      <span className="statusbar__item" title="Сколько последних минут можно сохранить клавишей F8">
        Буфер {mmss(status.bufferedMs)}
      </span>
      <span className="statusbar__item">
        {status.markerCount} {plural(status.markerCount, 'маркер', 'маркера', 'маркеров')}
      </span>
      <span className="statusbar__keys">
        <kbd>1</kbd>–<kbd>9</kbd> маркер · <kbd>F8</kbd> повтор · <kbd>F9</kbd> редактор
      </span>
    </div>
  );
}
