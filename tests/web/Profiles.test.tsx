// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultConfig } from '../../src/service/config';
import type { Profile } from '../../src/service/profiles';
import { settingsFromConfig } from '../../src/service/profileSettings';
import type { StreamStatus } from '../../src/service/streams';
import { Profiles } from '../../src/web/views/Profiles';

const mocks = vi.hoisted(() => ({ createProfile: vi.fn(), deleteProfile: vi.fn(), updateProfile: vi.fn() }));
vi.mock('../../src/web/api', () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly path?: string) {
      super(message);
    }
  }
  return { ApiError, api: mocks };
});

const settings = settingsFromConfig(defaultConfig('/d'));
const D: Profile = { id: 'd', name: 'По умолчанию', isDefault: true, settings, createdAt: '', updatedAt: '' };
const BIG: Profile = { id: 'b', name: 'Крупный канал', isDefault: false, settings, createdAt: '', updatedAt: '' };
const stream = (over: Partial<StreamStatus> = {}): StreamStatus => ({
  id: 's1', channel: 'alice', quality: 'best', state: 'RECORDING', startedAt: '', bufferedMs: 0, clipsCreated: 0,
  detector: { running: true, chat: 'connected', restarts: 0 }, signals: null,
  profile: { id: 'd', name: 'По умолчанию' }, profileVersion: 1, profileApplied: 1, profileBadPatterns: [],
  ...over,
});
const nameField = () => (screen.getByLabelText('Название') as HTMLInputElement).value;

beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('selects the first profile and switches on click', () => {
  render(<Profiles profiles={[D, BIG]} streams={[stream()]} />);
  expect(nameField()).toBe('По умолчанию');
  expect(screen.getByText('по умолчанию')).toBeTruthy();
  expect(screen.getByText('alice')).toBeTruthy();
  fireEvent.click(screen.getByText('Крупный канал'));
  expect(nameField()).toBe('Крупный канал');
});

it('creates a copy of the selected profile and selects it', async () => {
  const copy: Profile = { ...BIG, id: 'c', name: 'Мелкий канал' };
  mocks.createProfile.mockResolvedValue(copy);
  const { rerender } = render(<Profiles profiles={[D, BIG]} streams={[]} />);
  fireEvent.click(screen.getByText('Крупный канал'));
  fireEvent.change(screen.getByLabelText('Название копии'), { target: { value: 'Мелкий канал' } });
  fireEvent.click(screen.getByText('Создать'));
  await waitFor(() => expect(mocks.createProfile).toHaveBeenCalledWith('Мелкий канал', 'b'));
  rerender(<Profiles profiles={[D, BIG, copy]} streams={[]} />);
  await waitFor(() => expect(nameField()).toBe('Мелкий канал'));
});

it('hides delete for the default and disables it for a profile in use', () => {
  render(<Profiles profiles={[D, BIG]} streams={[stream({ profile: { id: 'b', name: BIG.name } })]} />);
  expect(screen.queryByText('Удалить')).toBeNull();
  fireEvent.click(screen.getByText('Крупный канал'));
  const del = screen.getByText('Удалить') as HTMLButtonElement;
  expect(del.disabled).toBe(true);
  expect(del.title).toBe('Профиль используется идущим эфиром');
});

it('asks before deleting', async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  mocks.deleteProfile.mockResolvedValue(undefined);
  render(<Profiles profiles={[D, BIG]} streams={[]} />);
  fireEvent.click(screen.getByText('Крупный канал'));
  fireEvent.click(screen.getByText('Удалить'));
  expect(confirm).toHaveBeenCalledWith('Удалить профиль «Крупный канал»?');
  expect(mocks.deleteProfile).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByText('Удалить'));
  await waitFor(() => expect(mocks.deleteProfile).toHaveBeenCalledWith('b'));
});

it('shows the api error', async () => {
  const { ApiError } = await import('../../src/web/api');
  vi.stubGlobal('confirm', () => true);
  mocks.deleteProfile.mockRejectedValue(new ApiError(409, 'Профиль используется'));
  render(<Profiles profiles={[D, BIG]} streams={[]} />);
  fireEvent.click(screen.getByText('Крупный канал'));
  fireEvent.click(screen.getByText('Удалить'));
  expect(await screen.findByText('Профиль используется')).toBeTruthy();
});

it('does not write a pending save into the profile selected meanwhile', async () => {
  let resolve!: (p: Profile) => void;
  mocks.updateProfile.mockReturnValue(new Promise<Profile>((r) => (resolve = r)));
  render(<Profiles profiles={[D, BIG]} streams={[]} />);
  fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Новое имя' } });
  fireEvent.click(screen.getByText('Сохранить'));
  fireEvent.click(screen.getByText('Крупный канал'));
  expect(nameField()).toBe('Крупный канал');
  resolve({ ...D, name: 'Новое имя' });
  await new Promise((r) => setTimeout(r, 0));
  expect(nameField()).toBe('Крупный канал');
});
