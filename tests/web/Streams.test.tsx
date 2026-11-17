// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultConfig } from '../../src/service/config';
import type { Profile } from '../../src/service/profiles';
import { settingsFromConfig } from '../../src/service/profileSettings';
import type { StreamStatus } from '../../src/service/streams';
import { Streams } from '../../src/web/views/Streams';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(), startStream: vi.fn(), stopStream: vi.fn(), manualClip: vi.fn(), setMode: vi.fn(), setStreamProfile: vi.fn(), tuning: vi.fn(),
}));
vi.mock('../../src/web/api', () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { ApiError, api: mocks };
});

const stream = (over: Partial<StreamStatus> = {}): StreamStatus => ({
  id: 's1', channel: 'shroud', quality: 'best', state: 'RECORDING', startedAt: '', bufferedMs: 42000, clipsCreated: 3,
  detector: { running: true, chat: 'connected', restarts: 0 },
  signals: { tMs: 0, chatSpike: 4, laughShare: 0, messages: 0, deltaDb: 10, vad: 0, warm: true },
  profile: { id: 'p1', name: 'По умолчанию' }, profileVersion: 1, profileApplied: 1, profileBadPatterns: [],
  ...over,
});
const prof = (id: string, name: string): Profile => ({ id, name, isDefault: id === 'p1', settings: settingsFromConfig(defaultConfig('/d')), createdAt: '', updatedAt: '' });
const PROFILES = [prof('p1', 'По умолчанию'), prof('p2', 'Крупный канал')];
const view = (p: Partial<Parameters<typeof Streams>[0]> = {}) =>
  render(<Streams streams={[]} multiStream={false} cutting={{ paused: false, reason: null }} profiles={PROFILES} tuningLive={{}} onMode={() => {}} {...p} />);

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.tuning.mockResolvedValue({ frames: [], entries: [] });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('asks for confirmation with the resource warning before enabling multi mode', async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  mocks.setMode.mockResolvedValue({ multiStream: true, limit: 5 });
  const onMode = vi.fn();
  view({ onMode });
  fireEvent.click(screen.getByLabelText('Несколько эфиров'));
  expect(confirm).toHaveBeenCalledWith('Режим «несколько эфиров» записывает до 5 эфиров одновременно и заметно сильнее нагружает процессор, диск и сеть. Включить?');
  await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith(true));
});

it('does not enable multi mode when the confirmation is declined', () => {
  vi.stubGlobal('confirm', () => false);
  view();
  fireEvent.click(screen.getByLabelText('Несколько эфиров'));
  expect(mocks.setMode).not.toHaveBeenCalled();
});

it('shows the api error text when start fails', async () => {
  const { ApiError } = await import('../../src/web/api');
  mocks.probe.mockResolvedValue({ channel: 'shroud', qualities: ['best', '720p'], profileId: 'p1' });
  mocks.startStream.mockRejectedValue(new ApiError(409, 'Достигнут лимит эфиров: 1'));
  view();
  fireEvent.change(screen.getByPlaceholderText('Ссылка на канал Twitch'), { target: { value: 'https://twitch.tv/shroud' } });
  fireEvent.click(screen.getByText('Проверить'));
  fireEvent.click(await screen.findByText('Начать'));
  expect(await screen.findByText('Достигнут лимит эфиров: 1')).toBeTruthy();
  expect(mocks.startStream).toHaveBeenCalledWith('https://twitch.tv/shroud', 'best', 'p1');
});

it('marks a stream whose detector is down and one without chat', () => {
  view({ streams: [stream({ detector: { running: false, chat: 'disconnected', restarts: 2 } })] });
  expect(screen.getByText('детектор не работает')).toBeTruthy();
  expect(screen.getByText('нет чата')).toBeTruthy();
  expect(screen.getByText('запись')).toBeTruthy();
});

it('shows why the detector is down next to the badge', () => {
  view({ streams: [stream({ detector: { running: false, chat: 'unknown', restarts: 3, lastError: 'ModuleNotFoundError: No module named numpy' } })] });
  expect(screen.getByText('детектор не работает')).toBeTruthy();
  expect(screen.getByText('ModuleNotFoundError: No module named numpy')).toBeTruthy();
});

it('does not show a stale detector error while the detector runs', () => {
  view({ streams: [stream({ detector: { running: true, chat: 'connected', restarts: 1, lastError: 'old failure' } })] });
  expect(screen.queryByText('old failure')).toBeNull();
});

it('shows the cutting-paused banner', () => {
  view({ cutting: { paused: true, reason: 'Мало места на диске' } });
  expect(screen.getByText('Мало места на диске')).toBeTruthy();
});

it('preselects the remembered profile and starts with the chosen one', async () => {
  mocks.probe.mockResolvedValue({ channel: 'shroud', qualities: ['best'], profileId: 'p2' });
  mocks.startStream.mockResolvedValue(stream());
  view();
  fireEvent.change(screen.getByPlaceholderText('Ссылка на канал Twitch'), { target: { value: 'https://twitch.tv/shroud' } });
  fireEvent.click(screen.getByText('Проверить'));
  const select = (await screen.findByLabelText('Профиль')) as HTMLSelectElement;
  expect(select.value).toBe('p2');
  fireEvent.change(select, { target: { value: 'p1' } });
  fireEvent.click(screen.getByText('Начать'));
  await waitFor(() => expect(mocks.startStream).toHaveBeenCalledWith('https://twitch.tv/shroud', 'best', 'p1'));
});

it('switches the profile on the card', async () => {
  mocks.setStreamProfile.mockResolvedValue(stream());
  view({ streams: [stream()] });
  fireEvent.change(screen.getByLabelText('Профиль'), { target: { value: 'p2' } });
  await waitFor(() => expect(mocks.setStreamProfile).toHaveBeenCalledWith('s1', 'p2'));
});

it('shows «применяется…» until the detector acknowledges', () => {
  const { rerender } = view({ streams: [stream({ profileVersion: 2, profileApplied: 1 })] });
  expect(screen.getByText('применяется…')).toBeTruthy();
  rerender(<Streams streams={[stream({ profileVersion: 2, profileApplied: 2 })]} multiStream={false} cutting={{ paused: false, reason: null }} profiles={PROFILES} tuningLive={{}} onMode={() => {}} />);
  expect(screen.queryByText('применяется…')).toBeNull();
});

it('remembers the tuning switch per channel', async () => {
  const { unmount } = view({ streams: [stream()] });
  expect(screen.queryByText('Журнал')).toBeNull();
  fireEvent.click(screen.getByLabelText('Настройка'));
  expect(localStorage.getItem('hl.tuning.shroud')).toBe('1');
  expect(await screen.findByText('Журнал')).toBeTruthy();
  unmount();
  cleanup();
  view({ streams: [stream()] });
  expect(await screen.findByText('Журнал')).toBeTruthy();
});

it('the editor opened from the tuning panel names every stream on the profile', async () => {
  localStorage.setItem('hl.tuning.shroud', '1');
  view({ streams: [stream(), stream({ id: 's2', channel: 'xqc' })] });
  await screen.findByText('Журнал');
  fireEvent.click(screen.getByText('Все настройки профиля'));
  expect(screen.getByText('Изменения сразу подействуют на эфиры: shroud, xqc')).toBeTruthy();
});

it('warns when the detector refused the profile', () => {
  view({ streams: [stream({ profileError: 'bad value' })] });
  const badge = screen.getByText('профиль не применён');
  expect(badge.className).toContain('warn');
  expect(badge.getAttribute('title')).toBe('bad value');
});

it('shows no profile warning without an error', () => {
  view({ streams: [stream()] });
  expect(screen.queryByText('профиль не применён')).toBeNull();
});
