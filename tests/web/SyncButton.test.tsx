// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriveStatus } from '../../src/service/http';
import { SyncButton } from '../../src/web/components/SyncButton';

const drive = (over: Partial<DriveStatus> = {}, sync: Partial<DriveStatus['sync']> = {}): DriveStatus => ({
  hasCredentials: true, clientId: 'cid', connected: true, email: 'u@example.com', folder: { id: 'F', name: 'to_sort', path: 'Мой диск / to_sort' },
  redirectUri: 'http://localhost:8080/api/drive/callback', redirectProblem: null,
  sync: { running: false, done: 0, total: 0, failed: 0, pending: 3, lastError: null, ...sync }, ...over,
});
afterEach(cleanup);
const view = (d: DriveStatus | null, onSync = vi.fn(async () => {}), onOpenDrive = vi.fn()) => {
  render(<SyncButton drive={d} onSync={onSync} onOpenDrive={onOpenDrive} />);
  return { onSync, onOpenDrive };
};

it('offers to upload the waiting clips and says that filters do not matter', async () => {
  const { onSync } = view(drive());
  const b = screen.getByRole('button', { name: 'Sync (3)' }) as HTMLButtonElement;
  expect(b.disabled).toBe(false);
  expect(b.title).toBe('Выгрузить все взятые клипы на Google Drive в папку «to_sort»');
  fireEvent.click(b);
  await waitFor(() => expect(onSync).toHaveBeenCalledTimes(1));
});
it('shows progress while running and cannot be pressed again', () => {
  view(drive({}, { running: true, done: 3, total: 7, pending: 4 }));
  expect((screen.getByRole('button', { name: 'Sync · 3 из 7' }) as HTMLButtonElement).disabled).toBe(true);
});
it('is idle when nothing waits', () => {
  view(drive({}, { pending: 0 }));
  const b = screen.getByRole('button', { name: 'Sync (0)' }) as HTMLButtonElement;
  expect([b.disabled, b.title]).toEqual([true, 'Все взятые клипы уже на Диске']);
});
it.each([
  ['no status yet', null],
  ['not connected', drive({ connected: false, email: null })],
  ['no folder', drive({ folder: null })],
])('leads to the Drive tab when Drive is not ready (%s)', (_n, d) => {
  const { onSync, onOpenDrive } = view(d);
  fireEvent.click(screen.getByRole('button', { name: 'Sync: настроить Диск' }));
  expect(onOpenDrive).toHaveBeenCalledTimes(1);
  expect(onSync).not.toHaveBeenCalled();
});
it('reports what went wrong: a stopped run, failed clips, a refused start', async () => {
  view(drive({}, { lastError: 'На Google Drive закончилось место' }));
  expect(screen.getByText('На Google Drive закончилось место')).toBeTruthy();
  cleanup();
  view(drive({}, { done: 5, total: 5, failed: 2, pending: 2 }));
  expect(screen.getByText('не выгружено: 2')).toBeTruthy();
  cleanup();
  view(drive(), vi.fn(async () => { throw new Error('Нет связи с сервером'); }));
  fireEvent.click(screen.getByRole('button', { name: 'Sync (3)' }));
  expect(await screen.findByText('Нет связи с сервером')).toBeTruthy();
});
