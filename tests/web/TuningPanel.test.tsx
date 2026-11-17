// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DetectorSignals } from '../../src/service/detectorProcess';
import { defaultConfig } from '../../src/service/config';
import type { DetectorDetail } from '../../src/service/detectorProcess';
import type { Profile } from '../../src/service/profiles';
import { settingsFromConfig } from '../../src/service/profileSettings';
import type { StreamStatus } from '../../src/service/streams';
import type { TuningEntry } from '../../src/service/tuningLog';
import { TuningPanel } from '../../src/web/components/TuningPanel';

const mocks = vi.hoisted(() => ({ tuning: vi.fn(), updateProfile: vi.fn() }));
vi.mock('../../src/web/api', () => {
  class ApiError extends Error {}
  return { ApiError, api: mocks };
});

const profile: Profile = { id: 'p1', name: 'Крупный канал', isDefault: false, settings: settingsFromConfig(defaultConfig('/d')), createdAt: '', updatedAt: '' };
const detail: DetectorDetail = {
  configVersion: 1, sinceStartMs: 720000,
  chat: { messages: 40, authors: 20, baseline: 2, spike: 3, triggerMessages: 5, triggerAuthors: 4, laughMessages: 4, reactionMessages: 1, triggerShare: 0.125 },
  conditions: { warm: true, spike: true, messages: true, authors: true, share: false, fired: false },
  audio: { db: -20, baselineDb: -30, deltaDb: 10, vad: 0.5, warm: true, spiking: false },
  score: { total: 1, share: 0, speed: 0, audio: 0 }, event: null,
};
const stream = (signals: StreamStatus['signals'] = { tMs: 1000, chatSpike: 3, laughShare: 0, messages: 0, deltaDb: 10, vad: 0.5, warm: true, detail }): StreamStatus => ({
  id: 's1', channel: 'shroud', quality: 'best', state: 'RECORDING', startedAt: '', bufferedMs: 0, clipsCreated: 0,
  detector: { running: true, chat: 'connected', restarts: 0 }, signals,
  profile: { id: 'p1', name: profile.name }, profileVersion: 1, profileApplied: 1, profileBadPatterns: [],
});
const near: TuningEntry = { at: '2026-11-16T10:00:00', kind: 'nearmiss', missing: ['share'], values: { spike: 2.6, messages: 16, triggerMessages: 5, triggerAuthors: 4, triggerShare: 0.3125 } };
const NEAR_TEXT = 'почти: не хватает состава · чат ×2,6 · состав 31,3 % (5 из 16) · 4 авт.';

/** A judged frame at second t with the given speed and composition (enough messages and authors). */
const frame = (t: number, spike: number, share: number): DetectorSignals => ({
  epoch: 1, tMs: t * 1000, chatSpike: spike, laughShare: 0, messages: 10, deltaDb: 0, vad: 0, warm: true,
  detail: { ...detail, chat: { ...detail.chat, spike, messages: 10, triggerMessages: 6, triggerAuthors: 4, triggerShare: share } },
});
// two firings at the saved thresholds (×2, 50 %): seconds 2 and 6; second 4 has speed ×1,7 only
const FRAMES = [frame(1, 1, 0.1), frame(2, 3, 0.8), frame(3, 1, 0.1), frame(4, 1.7, 0.8), frame(5, 1, 0.1), frame(6, 2.5, 0.6), frame(7, 1, 0)];
const panel = (over: Partial<Parameters<typeof TuningPanel>[0]> = {}) =>
  render(<TuningPanel stream={stream()} streams={[stream()]} profile={profile} liveEntries={[]} {...over} />);
const speedInput = () => screen.getByLabelText('Скорость чата: значение порога') as HTMLInputElement;

beforeEach(() => {
  mocks.tuning.mockReset();
  mocks.updateProfile.mockReset();
  mocks.tuning.mockResolvedValue({ frames: FRAMES, entries: [near] });
});
afterEach(cleanup);

it('loads the history and shows the chain, the verdict and the log', async () => {
  panel();
  expect(mocks.tuning).toHaveBeenCalledWith('s1');
  expect(screen.getByText('Всплеск')).toBeTruthy();
  expect(screen.getByText('не сработало: не хватает состава')).toBeTruthy();
  expect(await screen.findByText(NEAR_TEXT)).toBeTruthy();
});

it('adds live entries on top without duplicates', async () => {
  const live: TuningEntry = { at: '2026-11-16T10:00:05', kind: 'profile', name: 'Крупный канал', version: 2, badPatterns: [] };
  const { container } = panel({ liveEntries: [near, live] });
  await screen.findByText('применён профиль «Крупный канал»');
  const rows = [...container.querySelectorAll('.log-entry')].map((r) => r.textContent ?? '');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('применён профиль «Крупный канал»');
  expect(rows[1]).toContain(NEAR_TEXT);
});

it('waits for detector data', () => {
  panel({ stream: stream(null), streams: [stream(null)] });
  expect(screen.getByText('ждём данные детектора…')).toBeTruthy();
});

it('counts the firings of the last five minutes at the saved thresholds', async () => {
  const { container } = panel();
  expect(await screen.findByText(/С этими порогами за 5 минут: 2 срабатывания/)).toBeTruthy();
  expect(container.querySelectorAll('.mark')).toHaveLength(4); // two marks on each of the two charts
  expect((screen.getByText('Применить к профилю') as HTMLButtonElement).disabled).toBe(true);
});

it('re-counts with a dragged threshold and sends nothing until applied', async () => {
  panel();
  await screen.findByText(/2 срабатывания/);
  fireEvent.change(speedInput(), { target: { value: '1,6' } });
  expect(screen.getByText(/С этими порогами за 5 минут: 3 срабатывания \(с сохранёнными — 2\)/)).toBeTruthy();
  expect(screen.getByText('изменения ещё не применены')).toBeTruthy();
  expect(mocks.updateProfile).not.toHaveBeenCalled();
});

it('applies the draft to the profile, changing only the thresholds', async () => {
  mocks.updateProfile.mockImplementation(async (_id: string, patch: { settings: Profile['settings'] }) => ({ ...profile, settings: patch.settings, updatedAt: 'later' }));
  panel();
  await screen.findByText(/2 срабатывания/);
  fireEvent.change(speedInput(), { target: { value: '1,6' } });
  fireEvent.click(screen.getByText('Применить к профилю'));
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledTimes(1));
  const [id, patch] = mocks.updateProfile.mock.calls[0]!;
  expect(id).toBe('p1');
  const expected = structuredClone(profile.settings);
  expected.detector.chat.minSpike = 1.6;
  expect(patch).toEqual({ settings: expected });
});

it('shows the refusal of the server and keeps the draft', async () => {
  mocks.updateProfile.mockRejectedValue(new Error('нет связи'));
  panel();
  await screen.findByText(/2 срабатывания/);
  fireEvent.change(speedInput(), { target: { value: '3' } });
  fireEvent.click(screen.getByText('Применить к профилю'));
  expect(await screen.findByText('нет связи')).toBeTruthy();
  expect(speedInput().value).toBe('3');
});

it('resets the draft', async () => {
  panel();
  await screen.findByText(/2 срабатывания/);
  fireEvent.change(speedInput(), { target: { value: '4' } });
  fireEvent.click(screen.getByText('Сбросить'));
  expect(speedInput().value).toBe('2');
  expect(screen.queryByText('изменения ещё не применены')).toBeNull();
});

it('keeps the speed threshold between the end-of-event speed and the full-score speed', async () => {
  panel();
  fireEvent.change(speedInput(), { target: { value: '1,2' } });
  fireEvent.blur(speedInput());
  expect(screen.getByRole('slider', { name: 'Скорость чата: порог' }).getAttribute('aria-valuenow')).toBe('1.5');
  fireEvent.change(speedInput(), { target: { value: '9' } });
  fireEvent.blur(speedInput());
  expect(screen.getByRole('slider', { name: 'Скорость чата: порог' }).getAttribute('aria-valuenow')).toBe('5.9');
});

it('asks what to do when the profile changes elsewhere while a draft exists', async () => {
  const { rerender } = panel();
  fireEvent.change(speedInput(), { target: { value: '3' } });
  const changed: Profile = { ...profile, updatedAt: 'elsewhere', settings: { ...profile.settings, detector: { ...profile.settings.detector, chat: { ...profile.settings.detector.chat, minSpike: 2.5 } } } };
  rerender(<TuningPanel stream={stream()} streams={[stream()]} profile={changed} liveEntries={[]} />);
  expect(screen.getByText('Профиль изменён в другом окне')).toBeTruthy();
  expect(speedInput().value).toBe('3');
  fireEvent.click(screen.getByText('Взять новые'));
  expect(speedInput().value).toBe('2,5');
  expect(screen.queryByText('Профиль изменён в другом окне')).toBeNull();
});

it('names the other streams the profile is used by', () => {
  const other = { ...stream(), id: 's2', channel: 'gaules' };
  panel({ streams: [stream(), other] });
  fireEvent.change(speedInput(), { target: { value: '3' } });
  expect(screen.getByText('Изменения сразу подействуют и на эфиры: gaules')).toBeTruthy();
});

it('opens the editor of the stream profile', () => {
  panel();
  expect(screen.queryByLabelText('Название')).toBeNull();
  fireEvent.click(screen.getByText('Все настройки профиля'));
  expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Крупный канал');
});

it('prints negative dB with the minus sign and no plus', () => {
  const d: DetectorDetail = { ...detail, audio: { ...detail.audio, db: -78.2, baselineDb: -30.1, deltaDb: -48.1 } };
  const { container } = panel({ stream: stream({ tMs: 1000, chatSpike: 3, laughShare: 0, messages: 0, deltaDb: -48.1, vad: 0.5, warm: true, detail: d }) });
  const text = container.textContent ?? '';
  expect(text).toContain('−78,2 дБ · фон −30,1 дБ · −48,1 дБ');
  expect(text).not.toContain('+-');
  expect(text).not.toContain('+−');
});

it('uses the Russian plural for the chat message count', () => {
  const d: DetectorDetail = { ...detail, chat: { ...detail.chat, messages: 4 } };
  const { container } = panel({ stream: stream({ tMs: 1000, chatSpike: 3, laughShare: 0, messages: 0, deltaDb: 10, vad: 0.5, warm: true, detail: d }) });
  expect(container.textContent).toContain('4 сообщения за');
});
