import { join } from 'node:path';
import type { CaptureSession, Draft, Marker } from '@shared/types';
import { openDb } from '../../../src/main/db';
import { createRepos, type Repos } from '../../../src/main/db/repos';
import { tmpDir } from '../../helpers';

let repos: Repos;
beforeEach(() => {
  repos = createRepos(openDb(':memory:'));
});

const session = (id: string): CaptureSession => ({ id, streamer: 's', streamId: '1', state: 'RECORDING', startedAt: '2026-11-14T18:30:00.000Z', epoch: 0 });
const marker = (id: string, momentId: string, epoch: number, t: number): Marker => ({ id, momentId, epoch, type: 3, sourceTimeMs: t, comment: '' });
const draft = (id: string, sessionId: string): Draft => ({ id, sessionId, epoch: 0, startMs: 0, endMs: 1000, filePath: `/d/${id}.mp4`, createdAt: '2026-11-14T18:31:00.000Z' });

test('момент возвращается с маркерами, отсортированными по (epoch, sourceTimeMs)', () => {
  repos.moments.insert({ id: 'm1', streamSessionId: 's1', status: 'ACTIVE', draftId: null });
  repos.markers.insert(marker('c', 'm1', 1, 5));
  repos.markers.insert(marker('b', 'm1', 0, 900));
  repos.markers.insert(marker('a', 'm1', 0, 100));
  expect(repos.moments.get('m1')!.markers.map((m) => m.id)).toEqual(['a', 'b', 'c']);
});

test('activeFor возвращает только ACTIVE-момент сессии', () => {
  repos.moments.insert({ id: 'old', streamSessionId: 's1', status: 'SAVED', draftId: null });
  repos.moments.insert({ id: 'cur', streamSessionId: 's1', status: 'ACTIVE', draftId: null });
  repos.moments.insert({ id: 'other', streamSessionId: 's2', status: 'ACTIVE', draftId: null });
  expect(repos.moments.activeFor('s1')!.id).toBe('cur');
  expect(repos.moments.activeFor('nope')).toBeNull();
});

test('forDraft: FAILED-момент с этим draftId важнее ACTIVE-момента сессии', () => {
  repos.drafts.insert(draft('d1', 's1'));
  repos.moments.insert({ id: 'active', streamSessionId: 's1', status: 'ACTIVE', draftId: null });
  expect(repos.moments.forDraft('d1')!.id).toBe('active');
  repos.moments.insert({ id: 'failed', streamSessionId: 's1', status: 'FAILED', draftId: 'd1' });
  expect(repos.moments.forDraft('d1')!.id).toBe('failed');
  expect(repos.moments.forDraft('missing')).toBeNull();
});

test('markers.update переносит маркер в другой момент (momentId)', () => {
  repos.moments.insert({ id: 'm1', streamSessionId: 's1', status: 'ACTIVE', draftId: null });
  repos.moments.insert({ id: 'm2', streamSessionId: 's1', status: 'EXPORTING', draftId: null });
  repos.markers.insert(marker('a', 'm1', 0, 100));
  repos.markers.update('a', { momentId: 'm2', comment: 'hi', sourceTimeMs: 250, type: 7 });
  expect(repos.moments.get('m1')!.markers).toEqual([]);
  expect(repos.moments.get('m2')!.markers).toEqual([{ id: 'a', momentId: 'm2', epoch: 0, type: 7, sourceTimeMs: 250, comment: 'hi' }]);
});

test('sessions: insert, update и get', () => {
  repos.sessions.insert(session('s1'));
  repos.sessions.update('s1', { state: 'ERROR', error: 'boom', epoch: 2, endedAt: '2026-11-14T19:00:00.000Z' });
  expect(repos.sessions.get('s1')).toEqual({ ...session('s1'), state: 'ERROR', error: 'boom', epoch: 2 });
  expect(repos.sessions.get('zzz')).toBeNull();
});

test('drafts: update диапазона, list и remove', () => {
  repos.drafts.insert(draft('d1', 's1'));
  repos.drafts.insert(draft('d2', 's1'));
  repos.drafts.update('d1', { startMs: 10, endMs: 20 });
  expect(repos.drafts.get('d1')).toMatchObject({ startMs: 10, endMs: 20 });
  repos.drafts.remove('d2');
  expect(repos.drafts.list().map((d) => d.id)).toEqual(['d1']);
});

test('clips: insert, list и setSyncStatus', () => {
  const clip = { id: 'c1', momentId: 'm1', sessionId: 's1', title: 'T', dir: '/x', mp4Path: '/x/t.mp4', markersPath: '/x/markers.json', durationMs: 5, createdAt: '2026-11-14T19:42:00.000Z', syncStatus: 'pending' as const };
  repos.clips.insert(clip);
  repos.clips.setSyncStatus('c1', 'synced');
  expect(repos.clips.list()).toEqual([{ ...clip, syncStatus: 'synced' }]);
  expect(repos.clips.get('nope')).toBeNull();
});

test('driveFiles.upsert заменяет строку по (clipId, kind)', () => {
  repos.driveFiles.upsert({ clipId: 'c1', kind: 'mp4', driveFileId: 'f1', version: '1', md5: 'a', status: 'synced' });
  repos.driveFiles.upsert({ clipId: 'c1', kind: 'mp4', driveFileId: 'f1', version: '2', md5: 'b', status: 'synced' });
  expect(repos.driveFiles.get('c1', 'mp4')).toEqual({ clipId: 'c1', kind: 'mp4', driveFileId: 'f1', version: '2', md5: 'b', status: 'synced' });
  expect(repos.driveFiles.get('c1', 'markers')).toBeNull();
  repos.driveFiles.setFolder('a/b', 'id1');
  repos.driveFiles.setFolder('a/b', 'id2');
  expect(repos.driveFiles.getFolder('a/b')).toBe('id2');
  expect(repos.driveFiles.getFolder('a')).toBeNull();
});

test('повторный openDb того же файла не пересоздаёт таблицы и сохраняет данные', () => {
  const file = join(tmpDir(), 'thr.sqlite');
  const db1 = openDb(file);
  createRepos(db1).drafts.insert(draft('d1', 's1'));
  db1.close();
  const db2 = openDb(file);
  expect(createRepos(db2).drafts.get('d1')!.id).toBe('d1');
  db2.close();
});
