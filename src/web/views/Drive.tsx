import { useState } from 'react';
import type { DriveStatus } from '../../service/http';
import type { DriveFolder } from '../../service/driveSettings';
import { api } from '../api';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className={`card drive-step${done ? ' done' : ''}`}>
      <h3><span className="chain-n">{done ? '✓' : n}</span> {title}</h3>
      {children}
    </section>
  );
}

/** «Диск»: Google keys → account → upload folder. `navigate` leaves for Google's consent page. */
export function Drive({ drive, onChange, navigate = (url) => window.location.assign(url) }: {
  drive: DriveStatus | null; onChange(next: DriveStatus): void; navigate?: (url: string) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null); // null: not edited, show the stored one
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('to_sort');
  const [link, setLink] = useState('');
  const [found, setFound] = useState<DriveFolder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ keys?: string; account?: string; folder?: string }>({});
  const [copied, setCopied] = useState(false);

  if (!drive) return <p className="muted empty">загружается…</p>;

  const run = async (where: 'keys' | 'account' | 'folder', fn: () => Promise<void>) => {
    setBusy(true);
    setErrors({});
    try {
      await fn();
    } catch (e) {
      setErrors({ [where]: message(e) });
    } finally {
      setBusy(false);
    }
  };
  const id = clientId ?? drive.clientId;
  const keysChanged = id.trim() !== drive.clientId || secret.trim() !== '';
  const choose = (target: { id: string } | { link: string }) =>
    run('folder', async () => {
      onChange(await api.setDriveFolder(target));
      setFound(null);
      setLink('');
    });

  return (
    <div className="drive">
      <Step n={1} title="Ключи Google" done={drive.hasCredentials}>
        <ol className="muted howto">
          <li>В <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> создайте проект и включите Google Drive API.</li>
          <li>Создайте OAuth-клиент типа «Web application» и добавьте в него адрес возврата (ниже).</li>
          <li>Переведите приложение в статус «In production» — в статусе «Testing» вход слетает каждые 7 дней.</li>
        </ol>
        <div className="field">
          <span className="muted">Адрес возврата (Authorized redirect URI)</span>
          {drive.redirectProblem ? (
            <div className="banner">{drive.redirectProblem}</div>
          ) : (
            <div className="row">
              <code className="redirect">{drive.redirectUri}</code>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(drive.redirectUri).then(() => setCopied(true), () => undefined); }}>
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="drive-id">Client ID</label>
          <input id="drive-id" type="text" autoComplete="off" value={id} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="drive-secret">Client Secret</label>
          <input id="drive-secret" type="password" autoComplete="new-password" placeholder={drive.hasCredentials ? 'сохранён' : ''} value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
        <div className="row">
          <button type="button" className="primary" disabled={busy || !keysChanged || id.trim() === ''}
            onClick={() => void run('keys', async () => { onChange(await api.setDriveCredentials(id.trim(), secret.trim())); setClientId(null); setSecret(''); })}>
            Сохранить ключи
          </button>
          {drive.hasCredentials && !keysChanged && <span className="muted">ключи сохранены; секрет не показывается</span>}
        </div>
        {errors.keys && <div className="error">{errors.keys}</div>}
      </Step>

      <Step n={2} title="Аккаунт Google" done={drive.connected}>
        {drive.connected ? (
          <div className="row">
            <span>подключён: {drive.email ?? 'аккаунт Google'}</span>
            <button type="button" disabled={busy} onClick={() => void run('account', async () => { await api.driveDisconnect(); onChange({ ...drive, connected: false, email: null }); })}>
              Отключить
            </button>
          </div>
        ) : (
          <>
            <p className="muted">Сервис попросит полный доступ к Диску: только так можно писать в папку, которую создали вы, а не он.</p>
            <button type="button" className="primary" disabled={busy || !drive.hasCredentials || drive.redirectProblem !== null}
              onClick={() => void run('account', async () => navigate((await api.driveConnect()).url))}>
              Подключить Google Drive
            </button>
          </>
        )}
        {errors.account && <div className="error">{errors.account}</div>}
      </Step>

      <Step n={3} title="Папка выгрузки" done={drive.folder !== null}>
        {drive.folder ? (
          <p>Клипы выгружаются в папку <strong>{drive.folder.name}</strong> · <span className="muted">{drive.folder.path}</span></p>
        ) : (
          <p className="muted">Папка не выбрана. Найдите её по имени или вставьте ссылку.</p>
        )}
        <div className="field">
          <label htmlFor="drive-name">Имя папки</label>
          <div className="row">
            <input id="drive-name" type="text" value={name} disabled={!drive.connected} onChange={(e) => setName(e.target.value)} />
            <button type="button" disabled={busy || !drive.connected || name.trim() === ''} onClick={() => void run('folder', async () => setFound(await api.driveFolders(name.trim())))}>
              Найти
            </button>
          </div>
        </div>
        {found && (found.length === 0 ? (
          <div className="muted">Папок с таким именем нет</div>
        ) : (
          <ul className="folder-list">
            {found.map((f) => (
              <li key={f.id}>
                <span>{f.path}</span>
                <button type="button" disabled={busy} aria-label={`Выбрать ${f.path}`} onClick={() => void choose({ id: f.id })}>
                  {drive.folder?.id === f.id ? 'Выбрана' : 'Выбрать'}
                </button>
              </li>
            ))}
          </ul>
        ))}
        <div className="field">
          <label htmlFor="drive-link">Ссылка на папку</label>
          <div className="row">
            <input id="drive-link" type="text" placeholder="https://drive.google.com/drive/folders/…" value={link} disabled={!drive.connected} onChange={(e) => setLink(e.target.value)} />
            <button type="button" disabled={busy || !drive.connected || link.trim() === ''} onClick={() => void choose({ link: link.trim() })}>
              Выбрать по ссылке
            </button>
          </div>
        </div>
        {errors.folder && <div className="error">{errors.folder}</div>}
      </Step>
    </div>
  );
}
