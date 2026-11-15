// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StreamStatus } from '../../src/service/streams';
import { Streams } from '../../src/web/views/Streams';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(), startStream: vi.fn(), stopStream: vi.fn(), manualClip: vi.fn(), setMode: vi.fn(),
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
  ...over,
});
const view = (p: Partial<Parameters<typeof Streams>[0]> = {}) =>
  render(<Streams streams={[]} multiStream={false} cutting={{ paused: false, reason: null }} onMode={() => {}} {...p} />);

beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));
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
  mocks.probe.mockResolvedValue({ channel: 'shroud', qualities: ['best', '720p'] });
  mocks.startStream.mockRejectedValue(new ApiError(409, 'Достигнут лимит эфиров: 1'));
  view();
  fireEvent.change(screen.getByPlaceholderText('Ссылка на канал Twitch'), { target: { value: 'https://twitch.tv/shroud' } });
  fireEvent.click(screen.getByText('Проверить'));
  fireEvent.click(await screen.findByText('Начать'));
  expect(await screen.findByText('Достигнут лимит эфиров: 1')).toBeTruthy();
  expect(mocks.startStream).toHaveBeenCalledWith('https://twitch.tv/shroud', 'best');
});

it('marks a stream whose detector is down and one without chat', () => {
  view({ streams: [stream({ detector: { running: false, chat: 'disconnected', restarts: 2 } })] });
  expect(screen.getByText('детектор не работает')).toBeTruthy();
  expect(screen.getByText('нет чата')).toBeTruthy();
  expect(screen.getByText('запись')).toBeTruthy();
});

it('shows the cutting-paused banner', () => {
  view({ cutting: { paused: true, reason: 'Мало места на диске' } });
  expect(screen.getByText('Мало места на диске')).toBeTruthy();
});
