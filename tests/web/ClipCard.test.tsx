// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FeedClip } from '../../src/service/types';
import { ClipCard } from '../../src/web/components/ClipCard';

const setClipStatus = vi.fn();
vi.mock('../../src/web/api', () => ({ api: { setClipStatus: (...a: unknown[]) => setClipStatus(...a) } }));

const clip = (over: Partial<FeedClip> = {}): FeedClip => ({
  id: 'c1', sessionId: 's', streamer: 'shroud', streamId: 'x', epoch: 0, startMs: 0, endMs: 38000, durationMs: 38000, bytes: 1,
  triggers: ['laugh', 'audio'], confidence: 'normal', score: 4.3,
  signals: { chatSpike: 5.2, laughShare: 0.61, reactionShare: 0, deltaDb: 14 },
  status: 'new', error: null, mp4Path: '', jsonPath: '', fileDeleted: false, createdAt: '2026-11-15T19:42:00', statusChangedAt: null, profileId: null, profileName: null,
  ...over,
});

beforeEach(() => setClipStatus.mockReset());
afterEach(cleanup);

it('shows the preview, both triggers and the low-confidence badge', () => {
  const { container } = render(<ClipCard clip={clip({ confidence: 'low' })} onChange={() => {}} />);
  const video = container.querySelector('video')!;
  expect(video.getAttribute('src')).toBe('/media/clips/c1.mp4');
  expect(video.getAttribute('preload')).toBe('none');
  expect(screen.getByText(/смех \+ звук/)).toBeTruthy();
  expect(screen.getByText(/оценка 4,3/)).toBeTruthy();
  expect(screen.getByText('низкая уверенность')).toBeTruthy();
  expect(screen.getByText('чат ×5,2 · смех 61 % · звук +14 дБ')).toBeTruthy();
  expect(screen.getByText('Скачать').getAttribute('href')).toBe('/media/clips/c1.mp4?download=1');
});

it('calls setClipStatus("taken") on «Беру» and back to "new" on a second click', async () => {
  const onChange = vi.fn();
  setClipStatus.mockResolvedValue(clip({ status: 'taken' }));
  const { rerender } = render(<ClipCard clip={clip()} onChange={onChange} />);
  fireEvent.click(screen.getByText('Беру'));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(setClipStatus).toHaveBeenLastCalledWith('c1', 'taken');
  rerender(<ClipCard clip={clip({ status: 'taken' })} onChange={onChange} />);
  fireEvent.click(screen.getByText('Беру'));
  await waitFor(() => expect(setClipStatus).toHaveBeenCalledTimes(2));
  expect(setClipStatus).toHaveBeenLastCalledWith('c1', 'new');
});

it('shows «нарезается…» without a video for a pending clip', () => {
  const { container } = render(<ClipCard clip={clip({ status: 'pending' })} onChange={() => {}} />);
  expect(screen.getByText('нарезается…')).toBeTruthy();
  expect(container.querySelector('video')).toBeNull();
  expect(screen.queryByText('Беру')).toBeNull();
});

it('shows the error text for a failed clip', () => {
  render(<ClipCard clip={clip({ status: 'error', error: 'ffmpeg упал' })} onChange={() => {}} />);
  expect(screen.getByText('ffmpeg упал')).toBeTruthy();
});

it('shows «файл удалён» and no download link for a deleted file', () => {
  const { container } = render(<ClipCard clip={clip({ fileDeleted: true, status: 'rejected' })} onChange={() => {}} />);
  expect(screen.getByText('файл удалён')).toBeTruthy();
  expect(container.querySelector('video')).toBeNull();
  expect(screen.queryByText('Скачать')).toBeNull();
});

it('keeps the legacy «S 0,74» text for an old clip without triggerShare', () => {
  render(<ClipCard clip={clip({ score: 0.74 })} onChange={() => {}} />);
  expect(screen.getByText(/S 0,74/)).toBeTruthy();
  expect(screen.queryByText(/оценка/)).toBeNull();
});

it('shows no score for a manual clip', () => {
  render(<ClipCard clip={clip({ triggers: ['manual'], score: 0 })} onChange={() => {}} />);
  expect(screen.getByText(/вручную/)).toBeTruthy();
  expect(screen.queryByText(/оценка/)).toBeNull();
});
