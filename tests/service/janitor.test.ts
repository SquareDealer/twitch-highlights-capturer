import { openDb } from '../../src/main/db';
import { createClipRepo } from '../../src/service/clipRepo';
import { defaultConfig, type ServiceConfig } from '../../src/service/config';
import { Janitor } from '../../src/service/janitor';
import type { FeedClip } from '../../src/service/types';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const HOUR = 3600_000;
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const PAUSE_REASON = 'Мало места на диске: нарезка новых клипов приостановлена, запись эфиров продолжается';

const clip = (id: string, over: Partial<FeedClip> = {}): FeedClip => ({
  id, sessionId: 's1', streamer: 'alice', streamId: '42', epoch: 1, startMs: 1000, endMs: 31000, durationMs: 30000,
  bytes: 100, triggers: ['laugh'], confidence: 'normal', score: 0.8,
  signals: { chatSpike: 3, laughShare: 0.5, reactionShare: 0.1, deltaDb: 6 },
  status: 'rejected', error: null, mp4Path: `/c/${id}.mp4`, jsonPath: `/c/${id}.json`, fileDeleted: false,
  createdAt: iso(100), statusChangedAt: iso(30), profileId: null, profileName: null, ...over,
});

let clips: ReturnType<typeof createClipRepo>;
let cfg: ServiceConfig;
let free: number;
let unlinked: string[];
let freeAfterUnlink: number | null;
let missing: Set<string>;
let janitor: Janitor;

beforeEach(() => {
  clips = createClipRepo(openDb(':memory:'));
  cfg = { ...defaultConfig('/data'), diskReserveBytes: 1000, rejectedTtlHours: 24 };
  free = 10_000;
  freeAfterUnlink = null;
  unlinked = [];
  missing = new Set();
  janitor = new Janitor({
    clips,
    config: () => cfg,
    freeBytes: async () => free,
    unlink: async (p) => {
      if (missing.has(p)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      unlinked.push(p);
      if (freeAfterUnlink !== null) free = freeAfterUnlink;
    },
    now: () => NOW,
  });
});

it('deletes the mp4 of clips rejected more than 24 h ago and keeps the row and the json', async () => {
  clips.insert(clip('old', { statusChangedAt: iso(25) }));
  const emitted: FeedClip[] = [];
  janitor.on('clip', (c: FeedClip) => emitted.push(c));
  await janitor.run();
  expect(unlinked).toEqual(['/c/old.mp4']);
  expect(clips.get('old')).toMatchObject({ status: 'rejected', fileDeleted: true, jsonPath: '/c/old.json' });
  expect(emitted.map((c) => [c.id, c.fileDeleted])).toEqual([['old', true]]);
});

it('keeps recently rejected clips while there is enough space', async () => {
  clips.insert(clip('fresh', { statusChangedAt: iso(2) }));
  await janitor.run();
  expect(unlinked).toEqual([]);
  expect(clips.get('fresh')!.fileDeleted).toBe(false);
  expect(janitor.state()).toEqual({ paused: false, reason: null });
});

it('deletes all rejected files at once when space is below the reserve', async () => {
  clips.insert(clip('a', { statusChangedAt: iso(1) }));
  clips.insert(clip('b', { statusChangedAt: iso(2) }));
  free = 500;
  freeAfterUnlink = 5000;
  await janitor.run();
  expect(unlinked.sort()).toEqual(['/c/a.mp4', '/c/b.mp4']);
  expect(clips.get('a')!.fileDeleted).toBe(true);
  expect(clips.get('b')!.fileDeleted).toBe(true);
  expect(janitor.state()).toEqual({ paused: false, reason: null });
});

it('pauses cutting when deleting rejected files is not enough, and resumes when space returns', async () => {
  clips.insert(clip('a', { statusChangedAt: iso(1) }));
  const events: { paused: boolean; reason: string | null }[] = [];
  janitor.on('cutting', (e) => events.push(e));
  free = 500;
  await janitor.run();
  expect(janitor.state()).toEqual({ paused: true, reason: PAUSE_REASON });
  await janitor.run();
  expect(events).toEqual([{ paused: true, reason: PAUSE_REASON }]); // no repeat while state is unchanged
  free = 5000;
  await janitor.run();
  expect(janitor.state()).toEqual({ paused: false, reason: null });
  expect(events).toEqual([
    { paused: true, reason: PAUSE_REASON },
    { paused: false, reason: null },
  ]);
});

it('never deletes new, taken or pending clips', async () => {
  for (const status of ['new', 'taken', 'pending'] as const) {
    clips.insert(clip(status, { status, statusChangedAt: iso(500), createdAt: iso(600) }));
  }
  free = 500;
  await janitor.run();
  expect(unlinked).toEqual([]);
  for (const status of ['new', 'taken', 'pending']) expect(clips.get(status)!.fileDeleted).toBe(false);
  expect(janitor.state().paused).toBe(true);
});

it('survives a file that is already gone', async () => {
  clips.insert(clip('gone', { statusChangedAt: iso(30) }));
  clips.insert(clip('ok', { statusChangedAt: iso(31) }));
  missing.add('/c/gone.mp4');
  await janitor.run();
  expect(clips.get('gone')!.fileDeleted).toBe(true);
  expect(clips.get('ok')!.fileDeleted).toBe(true);
  expect(unlinked).toEqual(['/c/ok.mp4']);
});

it('skips a clip whose status changed to taken after the list was read', async () => {
  clips.insert(clip('a', { createdAt: iso(101), statusChangedAt: iso(30) }));
  clips.insert(clip('b', { statusChangedAt: iso(30) }));
  const unlink = async (p: string) => {
    unlinked.push(p);
    // while 'a' is being deleted the user takes 'b' (already in the janitor's list)
    if (p === '/c/a.mp4') clips.update('b', { status: 'taken', statusChangedAt: NOW.toISOString() });
  };
  janitor = new Janitor({ clips, config: () => cfg, freeBytes: async () => free, unlink, now: () => NOW });
  await janitor.run();
  expect(unlinked).toEqual(['/c/a.mp4']);
  expect(clips.get('b')).toMatchObject({ status: 'taken', fileDeleted: false });
});
