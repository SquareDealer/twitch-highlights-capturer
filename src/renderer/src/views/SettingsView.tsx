import { useEffect, useState } from 'react';
import type { DriveStatus, Settings } from '@shared/types';
import { useAppStore } from '../store';

type TextKey = 'libraryDir' | 'streamlinkPath' | 'ffmpegPath' | 'quality' | 'driveClientId' | 'driveClientSecret';
type NumberKey = 'captureLatencyMs' | 'defaultEmbedLatencyMs' | 'markerOffsetMs';
const LIMIT = 60_000;

export function SettingsView() {
  const { dispatch } = useAppStore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [drive, setDrive] = useState<DriveStatus>({ connected: false });
  const [connecting, setConnecting] = useState(false);

  const apply = (s: Settings) => {
    setSettings(s);
    setForm(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)])));
  };
  useEffect(() => {
    void window.thr.settings.get().then(apply);
    void window.thr.drive.status().then(setDrive);
  }, []);
  if (!settings) return null;

  const notify = (level: 'info' | 'warn' | 'error', message: string) => dispatch({ type: 'notice', notice: { level, message } });
  const commit = async (patch: Partial<Settings>) => apply(await window.thr.settings.set(patch));

  const text = (key: TextKey, label: string, hint?: string, type = 'text') => (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type={type}
        placeholder={type === 'password' ? 'Сохранённое значение скрыто; введите новое, чтобы заменить' : undefined}
        spellCheck={false}
        value={form[key] ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        onBlur={() => form[key] !== String(settings[key]) && void commit({ [key]: form[key] })}
      />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  const number = (key: NumberKey, label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        className="input input--number"
        inputMode="numeric"
        value={form[key] ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        onBlur={() => {
          const raw = (form[key] ?? '').trim();
          const value = Number(raw);
          if (!/^-?\d+$/.test(raw) || Math.abs(value) > LIMIT) {
            notify('warn', `Нужно целое число от −${LIMIT} до ${LIMIT} мс`);
            setForm({ ...form, [key]: String(settings[key]) });
          } else if (value !== settings[key]) {
            void commit({ [key]: value });
          }
        }}
      />
      <small className="muted">{hint}</small>
    </label>
  );

  return (
    <div className="settings">
      <section>
        <h3>Хранение и программы</h3>
        {text('libraryDir', 'Папка с клипами')}
        {text('streamlinkPath', 'Streamlink', 'Имя программы в PATH или полный путь к streamlink.exe')}
        {text('ffmpegPath', 'FFmpeg', 'Имя программы в PATH или полный путь к ffmpeg.exe')}
        {text('quality', 'Качество записи', 'best, 1080p60, 720p60…')}
      </section>

      <section>
        <h3>Точность маркеров</h3>
        <p className="muted">Плеер Twitch и запись получают эфир независимо. Если маркеры в редакторе стабильно опережают момент или отстают от него, поправьте сдвиг.</p>
        {number('markerOffsetMs', 'Ручной сдвиг маркеров, мс', 'Отрицательное значение ставит маркер раньше, положительное — позже')}
        {number('captureLatencyMs', 'Задержка записи (Streamlink), мс', 'Насколько запись отстаёт от эфира; по умолчанию 3000')}
        {number('defaultEmbedLatencyMs', 'Задержка плеера по умолчанию, мс', 'Используется, когда плеер Twitch не сообщает свою задержку; по умолчанию 4000')}
      </section>

      <section>
        <h3>Google Drive</h3>
        <p className="muted">Нужен собственный OAuth-клиент типа «Desktop app» из Google Cloud Console с включённым Drive API. Приложение видит только файлы, которые создало само.</p>
        {text('driveClientId', 'Client ID')}
        {text('driveClientSecret', 'Client Secret', undefined, 'password')}
        <label className="check">
          <input type="checkbox" checked={settings.driveAutoSync} onChange={(e) => void commit({ driveAutoSync: e.target.checked })} />
          Синхронизировать автоматически после сохранения клипа
        </label>
        <div className="settings__drive">
          <span>{drive.connected ? `Подключено: ${drive.email ?? 'аккаунт Google'}` : 'Не подключено'}</span>
          {drive.connected ? (
            <button className="button" onClick={() => void window.thr.drive.disconnect().then(() => window.thr.drive.status()).then(setDrive)}>Отключить</button>
          ) : (
            <button
              className="button button--primary"
              disabled={connecting}
              onClick={() => {
                setConnecting(true);
                void window.thr.drive
                  .connect()
                  .then((r) => (r.ok ? notify('info', 'Google Drive подключён') : notify('error', r.error)))
                  .catch((e: Error) => notify('error', e.message))
                  .then(() => window.thr.drive.status())
                  .then(setDrive)
                  .finally(() => setConnecting(false));
              }}
            >
              {connecting ? 'Ожидание браузера…' : 'Подключить'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
