import { openDb } from '../../src/main/db';
import { createClipRepo } from '../../src/service/clipRepo';
import type { FeedClip } from '../../src/service/types';

const clip = (id: string, over: Partial<FeedClip> = {}): FeedClip => ({
  id, sessionId: 's1', streamer: 'alice', streamId: '42', epoch: 1, startMs: 1000, endMs: 31000, durationMs: 30000,
  bytes: 123456, triggers: ['laugh', 'mass'], confidence: 'normal', score: 0.8,
  signals: { chatSpike: 3, laughShare: 0.5, reactionShare: 0.1, deltaDb: 6 },
  status: 'new', error: null, mp4Path: `/c/${id}.mp4`, jsonPath: `/c/${id}.json`, fileDeleted: false,
  createdAt: '2026-11-15T10:00:00.000Z', statusChangedAt: null, profileId: null, profileName: null, ...over,
});

let repo: ReturnType<typeof createClipRepo>;
beforeEach(() => {
  repo = createClipRepo(openDb(':memory:'));
});

test('вставка и чтение сохраняют все поля', () => {
  const c = clip('a', { error: 'x', fileDeleted: true, statusChangedAt: '2026-11-15T11:00:00.000Z', status: 'rejected' });
  repo.insert(c);
  expect(repo.get('a')).toEqual(c);
  expect(repo.get('nope')).toBeNull();
});

test('list фильтрует по статусу и сортирует по createdAt по убыванию', () => {
  repo.insert(clip('old', { createdAt: '2026-11-15T09:00:00.000Z' }));
  repo.insert(clip('new', { createdAt: '2026-11-15T12:00:00.000Z' }));
  repo.insert(clip('taken', { status: 'taken', createdAt: '2026-11-15T13:00:00.000Z' }));
  repo.insert(clip('bob', { streamer: 'bob', createdAt: '2026-11-15T14:00:00.000Z' }));
  expect(repo.list({ status: 'new', streamer: 'alice' }).map((c) => c.id)).toEqual(['new', 'old']);
  expect(repo.list({ limit: 2 }).map((c) => c.id)).toEqual(['bob', 'taken']);
});

test('update меняет только переданные поля', () => {
  repo.insert(clip('a'));
  repo.update('a', { status: 'taken', fileDeleted: true, bytes: 5 });
  const c = repo.get('a')!;
  expect([c.status, c.fileDeleted, c.bytes, c.durationMs]).toEqual(['taken', true, 5, 30000]);
});

test("failPending меняет только 'pending'", () => {
  repo.insert(clip('p', { status: 'pending' }));
  repo.insert(clip('n', { status: 'new' }));
  expect(repo.failPending('Сервис был перезапущен')).toBe(1);
  expect(repo.get('p')).toMatchObject({ status: 'error', error: 'Сервис был перезапущен' });
  expect(repo.get('n')!.status).toBe('new');
});

test("countSince и scoresSince не считают 'error'", () => {
  repo.insert(clip('a', { score: 1 }));
  repo.insert(clip('b', { status: 'error', score: 2 }));
  repo.insert(clip('c', { score: 3, createdAt: '2026-11-15T10:05:00.000Z' }));
  repo.insert(clip('d', { score: 4, createdAt: '2026-11-15T08:00:00.000Z' }));
  repo.insert(clip('e', { sessionId: 's2', score: 5 }));
  expect(repo.countSince('s1', '2026-11-15T09:00:00.000Z')).toBe(2);
  expect(repo.scoresSince('s1', '2026-11-15T09:00:00.000Z')).toEqual([1, 3]);
});

test("countSince и scoresSince не считают ручные клипы (triggers ровно ['manual'])", () => {
  repo.insert(clip('m', { triggers: ['manual'], score: 0 }));
  repo.insert(clip('d', { triggers: ['manual', 'laugh'], score: 2 }));
  repo.insert(clip('a', { score: 1 }));
  expect(repo.countSince('s1', '2026-11-15T09:00:00.000Z')).toBe(2);
  expect(repo.scoresSince('s1', '2026-11-15T09:00:00.000Z').sort()).toEqual([1, 2]);
});

test('rejectedWithFiles возвращает отклонённые клипы с файлами', () => {
  repo.insert(clip('r1', { status: 'rejected', statusChangedAt: '2026-11-01T00:00:00.000Z' }));
  repo.insert(clip('r2', { status: 'rejected', statusChangedAt: '2026-11-14T00:00:00.000Z' }));
  repo.insert(clip('r3', { status: 'rejected', fileDeleted: true }));
  repo.insert(clip('t', { status: 'taken' }));
  expect(repo.rejectedWithFiles().map((c) => c.id)).toEqual(['r1', 'r2']);
  expect(repo.rejectedWithFiles('2026-11-10T00:00:00.000Z').map((c) => c.id)).toEqual(['r1']);
});

it('stores and reads the profile of a clip', () => {
  repo.insert(clip('with', { profileId: 'p1', profileName: 'А' }));
  repo.insert(clip('without', { profileId: null, profileName: null }));
  expect(repo.get('with')).toMatchObject({ profileId: 'p1', profileName: 'А' });
  expect(repo.get('without')).toMatchObject({ profileId: null, profileName: null });
});

describe('Google Drive state of a clip', () => {
  const synced = (folderId: string) => ({ fileId: 'f1', folderId, status: 'synced' as const, error: null, syncedAt: '2026-11-17T10:00:00.000Z' });
  test('is absent until an upload is tried, then round-trips', () => {
    repo.insert(clip('a', { status: 'taken' }));
    expect('drive' in repo.get('a')!).toBe(false);
    repo.update('a', { drive: synced('F') });
    expect(repo.get('a')!.drive).toEqual(synced('F'));
    repo.update('a', { drive: { fileId: null, folderId: 'F', status: 'failed', error: 'нет сети', syncedAt: null } });
    expect(repo.get('a')!.drive).toEqual({ fileId: null, folderId: 'F', status: 'failed', error: 'нет сети', syncedAt: null });
  });
  test('the queue holds taken clips with a file that are not synced to this folder, oldest first', () => {
    repo.insert(clip('new', { status: 'new' }));
    repo.insert(clip('gone', { status: 'taken', fileDeleted: true }));
    repo.insert(clip('t2', { status: 'taken', createdAt: '2026-11-15T12:00:00.000Z' }));
    repo.insert(clip('t1', { status: 'taken', createdAt: '2026-11-15T11:00:00.000Z' }));
    repo.insert(clip('done', { status: 'taken' }));
    repo.update('done', { drive: synced('F') });
    repo.insert(clip('failed', { status: 'taken', createdAt: '2026-11-15T13:00:00.000Z' }));
    repo.update('failed', { drive: { fileId: null, folderId: 'F', status: 'failed', error: 'x', syncedAt: null } });
    expect(repo.driveQueue('F').map((c) => c.id)).toEqual(['t1', 't2', 'failed']);
    expect(repo.driveQueueCount('F')).toBe(3);
  });
  test('a clip synced to another folder is queued again', () => {
    repo.insert(clip('done', { status: 'taken' }));
    repo.update('done', { drive: synced('A') });
    expect(repo.driveQueue('A')).toEqual([]);
    expect(repo.driveQueue('B').map((c) => c.id)).toEqual(['done']);
  });
});

test('publicClip hides local paths and Drive ids, and links to the uploaded file', async () => {
  const { publicClip } = await import('../../src/service/http');
  const plain = publicClip(clip('a'));
  expect('mp4Path' in plain || 'jsonPath' in plain).toBe(false);
  expect(plain.drive).toBeNull();
  const up = publicClip(clip('b', { drive: { fileId: 'F 1', folderId: 'D', status: 'synced', error: null, syncedAt: 'x' } }));
  expect(up.drive).toEqual({ status: 'synced', error: null, url: 'https://drive.google.com/file/d/F%201/view' });
  expect(JSON.stringify(up)).not.toContain('folderId');
  expect(publicClip(clip('c', { drive: { fileId: null, folderId: 'D', status: 'failed', error: 'нет сети', syncedAt: null } })).drive)
    .toEqual({ status: 'failed', error: 'нет сети', url: null });
});
