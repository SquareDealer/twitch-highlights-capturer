import { useState } from 'react';
import type { DriveStatus } from '../../service/http';

/** «Sync» in the feed: uploads every taken clip that is not on Drive yet, whatever the feed filters show. */
export function SyncButton({ drive, onSync, onOpenDrive }: {
  drive: DriveStatus | null; onSync(): Promise<void>; onOpenDrive(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!drive || !drive.connected || !drive.folder) {
    return (
      <span className="sync">
        <button type="button" className="link" onClick={onOpenDrive}>Sync: настроить Диск</button>
      </span>
    );
  }

  const s = drive.sync;
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await onSync();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const problem = error || s.lastError || (!s.running && s.failed > 0 ? `не выгружено: ${s.failed}` : '');

  return (
    <span className="sync">
      <button
        type="button" className="primary" disabled={busy || s.running || s.pending === 0} onClick={() => void run()}
        title={s.pending === 0 && !s.running ? 'Все взятые клипы уже на Диске' : `Выгрузить все взятые клипы на Google Drive в папку «${drive.folder.name}»`}
      >
        {s.running ? `Sync · ${s.done} из ${s.total}` : `Sync (${s.pending})`}
      </button>
      {problem && <span className="error">{problem}</span>}
    </span>
  );
}
