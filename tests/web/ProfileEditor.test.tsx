// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultConfig } from '../../src/service/config';
import type { Profile } from '../../src/service/profiles';
import { settingsFromConfig } from '../../src/service/profileSettings';
import type { StreamStatus } from '../../src/service/streams';
import { ProfileEditor } from '../../src/web/components/ProfileEditor';

const mocks = vi.hoisted(() => ({ updateProfile: vi.fn() }));
vi.mock('../../src/web/api', () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly path?: string) {
      super(message);
    }
  }
  return { ApiError, api: mocks };
});

const P: Profile = {
  id: 'p1', name: 'Крупный канал', isDefault: false, settings: settingsFromConfig(defaultConfig('/d')),
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const stream = (over: Partial<StreamStatus> = {}): StreamStatus => ({
  id: 's1', channel: 'alice', quality: 'best', state: 'RECORDING', startedAt: '', bufferedMs: 0, clipsCreated: 0,
  detector: { running: true, chat: 'connected', restarts: 0 }, signals: null,
  profile: { id: 'other', name: 'Другой' }, profileVersion: 1, profileApplied: 1, profileBadPatterns: [],
  ...over,
});
const props = (over: Partial<Parameters<typeof ProfileEditor>[0]> = {}) => ({ profile: P, streams: [], ...over });
const view = (over: Partial<Parameters<typeof ProfileEditor>[0]> = {}) => render(<ProfileEditor {...props(over)} />);
const share = () => screen.getByLabelText(/Доля активных, не меньше/) as HTMLInputElement;

beforeEach(() => {
  mocks.updateProfile.mockReset();
});
afterEach(cleanup);

it('renders every field with its label and the current value', () => {
  const { container } = view();
  expect(share().value).toBe('0,05');
  expect(container.querySelectorAll('input[inputmode="decimal"]').length).toBe(28);
  expect(screen.getByLabelText('Название')).toBeTruthy();
  expect(screen.getByLabelText('Смех')).toBeTruthy();
  expect(screen.getByLabelText('Реакции')).toBeTruthy();
});

it('warns which running streams the edit will hit', () => {
  view({ streams: [stream({ channel: 'alice', profile: { id: P.id, name: P.name } }), stream({ id: 's2', channel: 'bob', profile: { id: P.id, name: P.name } })] });
  expect(screen.getByText('Изменения сразу подействуют на эфиры: alice, bob')).toBeTruthy();
});

it('saves parsed settings and reports how many streams got them', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view({ streams: [stream({ channel: 'alice', profile: { id: P.id, name: P.name } })] });
  fireEvent.change(share(), { target: { value: '0,08' } });
  fireEvent.click(screen.getByText('Сохранить'));
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalled());
  expect(mocks.updateProfile.mock.calls[0]![1].settings.detector.chat.minTriggerShare).toBe(0.08);
  expect(await screen.findByText('применено к эфирам: 1')).toBeTruthy();
});

it('says "сохранено" when no stream uses the profile', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view();
  fireEvent.change(share(), { target: { value: '0,08' } });
  fireEvent.click(screen.getByText('Сохранить'));
  expect(await screen.findByText('сохранено')).toBeTruthy();
});

it('does not send a request when a field is empty and shows the error at it', () => {
  view();
  fireEvent.change(screen.getByLabelText('Запас после события'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Сохранить'));
  expect(mocks.updateProfile).not.toHaveBeenCalled();
  expect(screen.getByText('«Запас после события»: нужно число')).toBeTruthy();
});

it('shows a server validation error at the field it names', async () => {
  const { ApiError } = await import('../../src/web/api');
  mocks.updateProfile.mockRejectedValue(new ApiError(400, '«Окно подсчёта сообщений»: допустимо от 1 до 60', 'detector.chat.windowS'));
  view();
  fireEvent.change(screen.getByLabelText('Окно подсчёта сообщений'), { target: { value: '99' } });
  fireEvent.click(screen.getByText('Сохранить'));
  const err = await screen.findByText('«Окно подсчёта сообщений»: допустимо от 1 до 60');
  expect(err.closest('.field')?.querySelector('#pf-detector\\.chat\\.windowS')).toBeTruthy();
});

it('shows a server error without a path under the buttons', async () => {
  const { ApiError } = await import('../../src/web/api');
  mocks.updateProfile.mockRejectedValue(new ApiError(0, 'Нет связи с сервером'));
  view();
  fireEvent.change(share(), { target: { value: '0,08' } });
  fireEvent.click(screen.getByText('Сохранить'));
  expect(await screen.findByText('Нет связи с сервером')).toBeTruthy();
});

it('saves on Enter in an input', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view();
  fireEvent.change(share(), { target: { value: '0,08' } });
  fireEvent.keyDown(share(), { key: 'Enter' });
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledTimes(1));
});

it('reverts the form', () => {
  view();
  const save = screen.getByText('Сохранить') as HTMLButtonElement;
  const revert = screen.getByText('Отменить изменения') as HTMLButtonElement;
  expect(save.disabled && revert.disabled).toBe(true);
  fireEvent.change(share(), { target: { value: '0,08' } });
  expect(save.disabled || revert.disabled).toBe(false);
  fireEvent.click(revert);
  expect(share().value).toBe('0,05');
  expect(save.disabled && revert.disabled).toBe(true);
});

it('resets the form when another profile is shown', () => {
  const { rerender } = view();
  fireEvent.change(share(), { target: { value: '0,08' } });
  rerender(<ProfileEditor {...props({ profile: { ...P, id: 'p2', name: 'Другой' } })} />);
  expect(share().value).toBe('0,05');
  expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Другой');
});

it('keeps unsaved edits when the same profile is updated from outside, but takes the update when clean', () => {
  const updated = { ...P, updatedAt: '2026-02-01T00:00:00Z', settings: { ...P.settings, cut: { ...P.settings.cut, postRollMs: 7000 } } };
  const { rerender, unmount } = view();
  fireEvent.change(share(), { target: { value: '0,08' } });
  rerender(<ProfileEditor {...props({ profile: updated })} />);
  expect(share().value).toBe('0,08');
  expect((screen.getByLabelText('Запас после события') as HTMLInputElement).value).toBe('10000');
  unmount();

  const clean = view();
  clean.rerender(<ProfileEditor {...props({ profile: updated })} />);
  expect((screen.getByLabelText('Запас после события') as HTMLInputElement).value).toBe('7000');
});

it('lists patterns the detector does not use', () => {
  view({ streams: [stream({ profile: { id: P.id, name: P.name }, profileBadPatterns: ['(('] })] });
  expect(screen.getByText('Не используется детектором: ((')).toBeTruthy();
});
