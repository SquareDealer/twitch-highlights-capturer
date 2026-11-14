import { useCallback, useEffect, useState } from 'react';
import { formatTimecode } from '@shared/time';
import type { Clip, Draft, DriveStatus, Moment } from '@shared/types';
import { useAppStore } from '../store';

const SYNC_LABEL: Record<Clip['syncStatus'], string> = { pending: 'Ожидает', synced: 'В облаке', failed: 'Ошибка' };
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};

export function LibraryView() {
  const { dispatch } = useAppStore();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [failed, setFailed] = useState<Moment[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [drive, setDrive] = useState<DriveStatus>({ connected: false });

  const refresh = useCallback(async () => {
    const [d, f, c, s] = await Promise.all([window.thr.drafts.list(), window.thr.clips.failed(), window.thr.clips.list(), window.thr.drive.status()]);
    setDrafts(d);
    setFailed(f);
    setClips(c);
    setDrive(s);
  }, []);

  useEffect(() => {
    void refresh();
    const off = [window.thr.on('drafts:changed', () => void refresh()), window.thr.on('clips:changed', () => void refresh())];
    return () => off.forEach((f) => f());
  }, [refresh]);

  const openEditor = (draftId: string) => dispatch({ type: 'view', view: 'editor', draftId });
  const failedDraftIds = new Set(failed.map((m) => m.draftId));
  const freeDrafts = drafts.filter((d) => !failedDraftIds.has(d.id));

  return (
    <div className="library">
      <section>
        <h3>Черновики</h3>
        {freeDrafts.length === 0 && <p className="muted">Пусто. F8 во время просмотра сохраняет последние 3 минуты в черновик.</p>}
        <ul className="rows">
          {freeDrafts.map((d) => (
            <li key={d.id} className="row">
              <span className="row__title">Повтор от {when(d.createdAt)}</span>
              <span className="muted">{formatTimecode(d.endMs - d.startMs)}</span>
              <span className="statusbar__spacer" />
              <button className="button button--small" onClick={() => openEditor(d.id)}>Открыть</button>
              <button
                className="button button--small button--danger"
                onClick={() => {
                  if (window.confirm('Удалить черновик? Видео будет потеряно.')) void window.thr.drafts.discard(d.id);
                }}
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      </section>

      {failed.length > 0 && (
        <section>
          <h3>Не сохранены</h3>
          <ul className="rows">
            {failed.map((m) => (
              <li key={m.id} className="row row--failed">
                <span className="row__title">Экспорт не удался · маркеров: {m.markers.length}</span>
                <span className="statusbar__spacer" />
                <button className="button button--small" onClick={() => m.draftId && openEditor(m.draftId)}>Открыть в редакторе</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="library__head">
          <h3>Клипы</h3>
          <span className="statusbar__spacer" />
          <span className="muted">{drive.connected ? `Google Drive: ${drive.email ?? 'подключён'}` : 'Google Drive не подключён'}</span>
          <button className="button button--small" disabled={!drive.connected || clips.length === 0} onClick={() => void window.thr.clips.syncAll()}>Синхронизировать всё</button>
        </div>
        {clips.length === 0 && <p className="muted">Сохранённых клипов пока нет.</p>}
        <ul className="rows">
          {clips.map((c) => (
            <li key={c.id} className="row">
              <span className="row__title">{c.title || 'Без названия'}</span>
              <span className="muted">{when(c.createdAt)}</span>
              <span className="muted">{formatTimecode(c.durationMs)}</span>
              <span className="statusbar__spacer" />
              <span className={`sync sync--${c.syncStatus}`}>{SYNC_LABEL[c.syncStatus]}</span>
              <button className="button button--small" onClick={() => void window.thr.clips.showInFolder(c.id)}>Показать в папке</button>
              <button className="button button--small" disabled={!drive.connected} onClick={() => void window.thr.clips.sync(c.id)}>Синхронизировать</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
