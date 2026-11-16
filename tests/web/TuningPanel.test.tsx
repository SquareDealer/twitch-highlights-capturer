// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  chat: { messages: 40, authors: 20, baseline: 2, spike: 3, triggerMessages: 5, triggerAuthors: 4, laughMessages: 4, reactionMessages: 1, activeAuthors: 128, activeAuthorsRaw: 128, triggerShare: 0.031 },
  conditions: { warm: true, messages: true, authors: true, share: false, fired: false },
  audio: { db: -20, baselineDb: -30, deltaDb: 10, vad: 0.5, warm: true, spiking: false },
  score: { total: 1, share: 0, speed: 0, audio: 0 }, event: null,
};
const stream = (signals: StreamStatus['signals'] = { tMs: 1000, chatSpike: 3, laughShare: 0, messages: 0, deltaDb: 10, vad: 0.5, warm: true, detail }): StreamStatus => ({
  id: 's1', channel: 'shroud', quality: 'best', state: 'RECORDING', startedAt: '', bufferedMs: 0, clipsCreated: 0,
  detector: { running: true, chat: 'connected', restarts: 0 }, signals,
  profile: { id: 'p1', name: profile.name }, profileVersion: 1, profileApplied: 1, profileBadPatterns: [],
});
const near: TuningEntry = { at: '2026-11-16T10:00:00', kind: 'nearmiss', missing: ['share'], values: { triggerMessages: 5, triggerAuthors: 4, triggerShare: 0.031 } };
const NEAR_TEXT = 'почти: не хватает доли · 5 сообщ., 4 авт., доля 3,1 %';

beforeEach(() => {
  mocks.tuning.mockReset();
  mocks.tuning.mockResolvedValue({ frames: [], entries: [near] });
});
afterEach(cleanup);

it('loads the history and shows the conditions, the verdict and the log', async () => {
  render(<TuningPanel stream={stream()} profile={profile} liveEntries={[]} />);
  expect(mocks.tuning).toHaveBeenCalledWith('s1');
  expect(screen.getByText('доля активных')).toBeTruthy();
  expect(screen.getByText('не сработало: не хватает доли')).toBeTruthy();
  expect(await screen.findByText(NEAR_TEXT)).toBeTruthy();
});

it('marks failed conditions', () => {
  render(<TuningPanel stream={stream()} profile={profile} liveEntries={[]} />);
  expect(screen.getByText('доля активных').parentElement!.className).toContain('bad');
  expect(screen.getByText('авторов').parentElement!.className).toContain('ok');
  expect(screen.getByText('прогрев').parentElement!.className).toContain('ok');
});

it('adds live entries on top without duplicates', async () => {
  const live: TuningEntry = { at: '2026-11-16T10:00:05', kind: 'profile', name: 'Крупный канал', version: 2, badPatterns: [] };
  const { container } = render(<TuningPanel stream={stream()} profile={profile} liveEntries={[near, live]} />);
  await screen.findByText('применён профиль «Крупный канал»');
  const rows = [...container.querySelectorAll('.log-entry')].map((r) => r.textContent ?? '');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('применён профиль «Крупный канал»');
  expect(rows[1]).toContain(NEAR_TEXT);
});

it('waits for detector data', () => {
  render(<TuningPanel stream={stream(null)} profile={profile} liveEntries={[]} />);
  expect(screen.getByText('ждём данные детектора…')).toBeTruthy();
});

it('draws two sparklines with the thresholds of the profile', () => {
  render(<TuningPanel stream={stream()} profile={profile} liveEntries={[]} />);
  expect(screen.getByLabelText('доля').querySelector('.threshold')).toBeTruthy();
  expect(screen.getByLabelText('скорость').querySelector('.threshold')).toBeTruthy();
});

it('opens the editor of the stream profile', () => {
  render(<TuningPanel stream={stream()} profile={profile} liveEntries={[]} />);
  expect(screen.queryByLabelText('Название')).toBeNull();
  fireEvent.click(screen.getByText('Изменить профиль'));
  expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Крупный канал');
});
