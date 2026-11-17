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
const SHARE = 'Состав: триггерных сообщений, не меньше';
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const share = () => field(SHARE);
const save = () => screen.getByRole('button', { name: 'Сохранить' });

beforeEach(() => {
  mocks.updateProfile.mockReset();
});
afterEach(cleanup);

it('renders every field with its label and the current value in display units', () => {
  const { container } = view();
  expect(share().value).toBe('50');
  expect(field('Запас до события').value).toBe('15');
  expect(container.querySelectorAll('input[inputmode="decimal"]').length).toBe(27);
  expect(screen.getByLabelText('Название')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Смех' })).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Реакции' })).toBeTruthy();
});

it('keeps the six basic fields on top and the rest in collapsed groups', () => {
  const { container } = view();
  const basic = container.querySelector('.editor-basic')!;
  expect([...basic.querySelectorAll('label')].map((l) => l.textContent)).toEqual([
    'Всплеск: чат быстрее фона в', SHARE, 'Триггерных сообщений, не меньше', 'Авторов триггерных сообщений, не меньше', 'Запас до события', 'Запас после события',
  ]);
  const groups = [...container.querySelectorAll('details.editor-group')] as HTMLDetailsElement[];
  expect(groups.map((g) => g.querySelector('summary')!.textContent)).toEqual(['Событие', 'Оценка', 'Звук', 'Нарезка', 'Окна']);
  expect(groups.every((g) => !g.open)).toBe(true);
});

it('counts the fields of a group that differ from the factory values', () => {
  const changed = structuredClone(P.settings);
  changed.detector.score.spikeFull = 8;
  changed.detector.score.audioMinDb = 12;
  const { container } = view({ profile: { ...P, settings: changed } });
  const score = [...container.querySelectorAll('details.editor-group summary')].find((x) => x.textContent!.startsWith('Оценка'))!;
  expect(score.textContent).toBe('Оценка · изменено 2');
});

it('warns which running streams the edit will hit', () => {
  view({ streams: [stream({ channel: 'alice', profile: { id: P.id, name: P.name } }), stream({ id: 's2', channel: 'bob', profile: { id: P.id, name: P.name } })] });
  expect(screen.getByText('Изменения сразу подействуют на эфиры: alice, bob')).toBeTruthy();
});

it('shows the bar with the number of unsaved fields only while something is edited', () => {
  view();
  expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
  fireEvent.change(share(), { target: { value: '60' } });
  expect(screen.getByText('изменено 1 поле')).toBeTruthy();
  fireEvent.change(field('Запас до события'), { target: { value: '20' } });
  expect(screen.getByText('изменено 2 поля')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  expect(share().value).toBe('50');
  expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
});

it('saves stored units and reports how many streams got them', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view({ streams: [stream({ channel: 'alice', profile: { id: P.id, name: P.name } })] });
  fireEvent.change(field('Всплеск: чат быстрее фона в'), { target: { value: '5' } });
  fireEvent.change(share(), { target: { value: '60' } });
  fireEvent.click(save());
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalled());
  const sent = mocks.updateProfile.mock.calls[0]![1].settings;
  expect([sent.detector.chat.minSpike, sent.detector.chat.minTriggerShare, sent.cut.preRollMs]).toEqual([5, 0.6, 15000]);
  expect(await screen.findByText('применено к эфирам: 1')).toBeTruthy();
});

it('says "сохранено" when no stream uses the profile', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view();
  fireEvent.change(share(), { target: { value: '60' } });
  fireEvent.click(save());
  expect(await screen.findByText('сохранено')).toBeTruthy();
});

it('does not send a request when a field is empty and shows the error at it', () => {
  view();
  fireEvent.change(field('Запас после события'), { target: { value: '' } });
  fireEvent.click(save());
  expect(mocks.updateProfile).not.toHaveBeenCalled();
  expect(screen.getByText('«Запас после события»: нужно число')).toBeTruthy();
});

it('blocks a save that breaks a pair rule and opens the group of the field', () => {
  const { container } = view();
  fireEvent.change(field('Всплеск: чат быстрее фона в'), { target: { value: '7' } });
  fireEvent.click(save());
  expect(mocks.updateProfile).not.toHaveBeenCalled();
  const err = screen.getByText('«Скорость чата, дающая 5 баллов» должна быть больше порога всплеска');
  expect((err.closest('details') as HTMLDetailsElement).open).toBe(true);
  expect(container.querySelectorAll('details.editor-group[open]')).toHaveLength(1);
});

it('shows a server validation error at the field it names', async () => {
  const { ApiError } = await import('../../src/web/api');
  mocks.updateProfile.mockRejectedValue(new ApiError(400, 'отказ сервера', 'detector.chat.windowS'));
  view();
  fireEvent.change(field('Окно подсчёта сообщений'), { target: { value: '9' } });
  fireEvent.click(save());
  const err = await screen.findByText('отказ сервера');
  expect(err.closest('.field')?.querySelector('#pf-detector\\.chat\\.windowS')).toBeTruthy();
  expect((err.closest('details') as HTMLDetailsElement).open).toBe(true);
});

it('shows a server error without a path next to the buttons', async () => {
  const { ApiError } = await import('../../src/web/api');
  mocks.updateProfile.mockRejectedValue(new ApiError(0, 'Нет связи с сервером'));
  view();
  fireEvent.change(share(), { target: { value: '60' } });
  fireEvent.click(save());
  expect(await screen.findByText('Нет связи с сервером')).toBeTruthy();
});

it('saves on Enter in a number input', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view();
  fireEvent.change(share(), { target: { value: '60' } });
  fireEvent.keyDown(share(), { key: 'Enter' });
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledTimes(1));
});

it('edits dictionaries as chips and saves them as lists', async () => {
  mocks.updateProfile.mockResolvedValue(P);
  view();
  const add = screen.getByLabelText('Смех: добавить шаблон');
  fireEvent.change(add, { target: { value: '^бугага$' } });
  fireEvent.keyDown(add, { key: 'Enter' });
  expect(mocks.updateProfile).not.toHaveBeenCalled(); // Enter in the chip input adds a chip, it does not save
  fireEvent.click(screen.getByRole('button', { name: 'Удалить ^lul$' }));
  fireEvent.click(save());
  await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalled());
  const words: string[] = mocks.updateProfile.mock.calls[0]![1].settings.detector.chat.laughWords;
  expect(words.includes('^бугага$') && !words.includes('^lul$')).toBe(true);
  expect(words).toHaveLength(P.settings.detector.chat.laughWords.length);
});

it('tells what a chat message would count as, with the patterns being edited', () => {
  view();
  const probe = screen.getByLabelText('Проверить сообщение');
  const result = () => screen.getByTestId('probe-result').textContent;
  expect(result()).toBe('');
  fireEvent.change(probe, { target: { value: 'ахахах' } });
  expect(result()).toBe('смех');
  fireEvent.change(probe, { target: { value: 'НЕЕЕЕТ' } });
  expect(result()).toBe('реакция');
  fireEvent.change(probe, { target: { value: 'привет всем' } });
  expect(result()).toBe('не триггер');
  const add = screen.getByLabelText('Реакции: добавить шаблон');
  fireEvent.change(add, { target: { value: '^привет$' } });
  fireEvent.keyDown(add, { key: 'Enter' });
  expect(result()).toBe('реакция');
});

it('resets the form when another profile is shown', () => {
  const { rerender } = view();
  fireEvent.change(share(), { target: { value: '60' } });
  rerender(<ProfileEditor {...props({ profile: { ...P, id: 'p2', name: 'Другой' } })} />);
  expect(share().value).toBe('50');
  expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Другой');
});

it('keeps unsaved edits when the same profile is updated from outside, but takes the update when clean', () => {
  const updated = { ...P, updatedAt: '2026-02-01T00:00:00Z', settings: { ...P.settings, cut: { ...P.settings.cut, postRollMs: 7000 } } };
  const { rerender, unmount } = view();
  fireEvent.change(share(), { target: { value: '60' } });
  rerender(<ProfileEditor {...props({ profile: updated })} />);
  expect(share().value).toBe('60');
  expect(field('Запас после события').value).toBe('10');
  unmount();

  const clean = view();
  clean.rerender(<ProfileEditor {...props({ profile: updated })} />);
  expect(field('Запас после события').value).toBe('7');
});

it('marks patterns the detector does not use', () => {
  const settings = structuredClone(P.settings);
  settings.detector.chat.laughWords = ['((', '^lol$'];
  const { container } = view({ profile: { ...P, settings }, streams: [stream({ profile: { id: P.id, name: P.name }, profileBadPatterns: ['(('] })] });
  expect(screen.getByText('Не используется детектором: ((')).toBeTruthy();
  expect(container.querySelector('.chip.bad')!.textContent).toContain('((');
});

it('opens a profile with a missing key and names the field on save', () => {
  const broken = structuredClone(P.settings) as any;
  delete broken.detector.chat.minSpike;
  view({ profile: { ...P, settings: broken } });
  expect(field('Всплеск: чат быстрее фона в').value).toBe('');
  fireEvent.change(share(), { target: { value: '60' } });
  fireEvent.click(save());
  expect(mocks.updateProfile).not.toHaveBeenCalled();
  expect(screen.getByText('«Всплеск: чат быстрее фона в»: нужно число')).toBeTruthy();
});
