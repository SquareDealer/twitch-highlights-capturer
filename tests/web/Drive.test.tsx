// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriveStatus } from '../../src/service/http';
import { Drive } from '../../src/web/views/Drive';

const mocks = vi.hoisted(() => ({
  setDriveCredentials: vi.fn(), driveConnect: vi.fn(), driveDisconnect: vi.fn(), driveFolders: vi.fn(), setDriveFolder: vi.fn(),
}));
vi.mock('../../src/web/api', () => ({ api: mocks }));

const status = (over: Partial<DriveStatus> = {}): DriveStatus => ({
  hasCredentials: false, clientId: '', connected: false, email: null, folder: null,
  redirectUri: 'http://localhost:8080/api/drive/callback', redirectProblem: null,
  sync: { running: false, done: 0, total: 0, failed: 0, pending: 0, lastError: null }, ...over,
});
const READY = { hasCredentials: true, clientId: 'cid.apps', connected: true, email: 'u@example.com' };
let onChange: ReturnType<typeof vi.fn<(next: DriveStatus) => void>>;
let go: ReturnType<typeof vi.fn<(url: string) => void>>;
const view = (d: DriveStatus | null) => render(<Drive drive={d} onChange={onChange} navigate={go} />);

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  onChange = vi.fn();
  go = vi.fn();
});
afterEach(cleanup);

it('waits for the status', () => {
  view(null);
  expect(screen.getByText('загружается…')).toBeTruthy();
});

it('step 1: shows the redirect address to register and saves the keys', async () => {
  mocks.setDriveCredentials.mockResolvedValue(status({ hasCredentials: true, clientId: 'cid.apps' }));
  view(status());
  expect(screen.getByText('http://localhost:8080/api/drive/callback')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Подключить Google Drive' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' cid.apps ' } });
  fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'sec' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключи' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ hasCredentials: true })));
  expect(mocks.setDriveCredentials).toHaveBeenCalledWith('cid.apps', 'sec');
});

it('never shows the stored secret, only that it is saved', () => {
  const { container } = view(status({ hasCredentials: true, clientId: 'cid.apps' }));
  const secret = screen.getByLabelText('Client Secret') as HTMLInputElement;
  expect([secret.value, secret.placeholder, secret.type]).toEqual(['', 'сохранён', 'password']);
  expect((screen.getByLabelText('Client ID') as HTMLInputElement).value).toBe('cid.apps');
  expect(container.textContent).not.toContain('sec');
});

it('says so when Google will not accept this address', () => {
  view(status({ redirectProblem: 'Google принимает адрес возврата только вида http://localhost или https:// с доменом. Откройте интерфейс по такому адресу.' }));
  expect(screen.getByText(/Google принимает адрес возврата только вида/)).toBeTruthy();
  expect(screen.queryByText('http://localhost:8080/api/drive/callback')).toBeNull();
});

it('step 2: goes to Google with the link from the server', async () => {
  mocks.driveConnect.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
  view(status({ hasCredentials: true, clientId: 'cid.apps' }));
  fireEvent.click(screen.getByRole('button', { name: 'Подключить Google Drive' }));
  await waitFor(() => expect(go).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
});

it('step 2: shows the account and disconnects', async () => {
  mocks.driveDisconnect.mockResolvedValue(undefined);
  view(status(READY));
  expect(screen.getByText(/подключён: u@example.com/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Отключить' }));
  await waitFor(() => expect(mocks.driveDisconnect).toHaveBeenCalled());
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connected: false, email: null }));
});

it('step 3 is closed until an account is connected', () => {
  view(status({ hasCredentials: true, clientId: 'cid.apps' }));
  expect((screen.getByRole('button', { name: 'Найти' }) as HTMLButtonElement).disabled).toBe(true);
});

it('step 3: finds folders named to_sort and takes the chosen one', async () => {
  mocks.driveFolders.mockResolvedValue([
    { id: 'A', name: 'to_sort', path: 'Мой диск / Работа / to_sort' }, { id: 'B', name: 'to_sort', path: 'Мой диск / to_sort' },
  ]);
  mocks.setDriveFolder.mockResolvedValue(status({ ...READY, folder: { id: 'B', name: 'to_sort', path: 'Мой диск / to_sort' } }));
  view(status(READY));
  expect((screen.getByLabelText('Имя папки') as HTMLInputElement).value).toBe('to_sort');
  fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
  expect(await screen.findByText('Мой диск / Работа / to_sort')).toBeTruthy();
  expect(mocks.driveFolders).toHaveBeenCalledWith('to_sort');
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать Мой диск / to_sort' }));
  await waitFor(() => expect(mocks.setDriveFolder).toHaveBeenCalledWith({ id: 'B' }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ folder: expect.objectContaining({ id: 'B' }) }));
});

it('step 3: says when no folder has that name and shows a refusal', async () => {
  mocks.driveFolders.mockResolvedValue([]);
  view(status(READY));
  fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
  expect(await screen.findByText('Папок с таким именем нет')).toBeTruthy();
  mocks.setDriveFolder.mockRejectedValue(new Error('Это не ссылка на папку Google Drive'));
  fireEvent.change(screen.getByLabelText('Ссылка на папку'), { target: { value: 'nonsense' } });
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать по ссылке' }));
  expect(await screen.findByText('Это не ссылка на папку Google Drive')).toBeTruthy();
  expect(mocks.setDriveFolder).toHaveBeenCalledWith({ link: 'nonsense' });
});

it('step 3: shows the chosen folder with its path', () => {
  view(status({ ...READY, folder: { id: 'B', name: 'to_sort', path: 'Мой диск / Работа / to_sort' } }));
  expect(screen.getByText('Мой диск / Работа / to_sort')).toBeTruthy();
  expect(screen.getByText(/Клипы выгружаются в папку/)).toBeTruthy();
});
