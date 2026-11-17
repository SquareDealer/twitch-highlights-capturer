import type { CaptureSession, CaptureState, Segment } from '@shared/types';
import { RingBufferManager } from '../../../src/server/capture/ringBuffer';
import { TimeSynchronizer } from '../../../src/server/capture/timeSync';
import { openDb } from '../../../src/server/db';
import { createRepos } from '../../../src/server/db/repos';
import { MomentService } from '../../../src/server/moments/momentService';
import { defaultSettings, SettingsStore } from '../../../src/server/settings';

/** Wall time of source time 0 in every epoch fed through `world.feed`. */
export const WALL0 = 1_000_000;

export function makeWorld() {
  const repos = createRepos(openDb(':memory:'));
  const settings = new SettingsStore(repos.db, defaultSettings({ videos: '/v', userData: '/u' }));
  // Embed and capture latency cancel out, so marker time == capture time in tests.
  settings.set({ captureLatencyMs: 4000, defaultEmbedLatencyMs: 4000 });
  const clock = { now: WALL0 };
  const unlinked: string[] = [];
  const ring = new RingBufferManager({
    segments: repos.segments, retentionMs: 300_000, maxPinnedBytes: 1e12, now: () => clock.now,
    unlink: async (p) => void unlinked.push(p),
  });
  const timeSync = new TimeSynchronizer(() => settings.get(), () => clock.now);
  let session: CaptureSession | null = { id: 's1', streamer: 'foo', streamId: '987654321', state: 'RECORDING', startedAt: '2026-11-14T18:30:00.000Z', epoch: 0 };
  let n = 0;
  const newId = () => `id${++n}`;
  const moments = new MomentService({ repos, ring, timeSync, currentSession: () => session, settings, newId });
  const world = {
    repos, settings, clock, ring, timeSync, moments, unlinked, newId,
    session: () => session,
    setSession(patch: Partial<CaptureSession> | null) {
      session = patch === null ? null : { ...session!, ...patch };
    },
    setState(state: CaptureState) {
      world.setSession({ state });
    },
    /** Adds 2-second segments covering [fromMs, toMs) of `epoch`; advances the clock to the end of the last one. */
    feed(epoch: number, fromMs: number, toMs: number): Segment[] {
      const out: Segment[] = [];
      for (let start = fromMs; start < toMs; start += 2000) {
        const seg: Segment = {
          sessionId: 's1', epoch, seq: start / 2000, path: `/buf/e${epoch}/seg_${start / 2000}.ts`,
          startMs: start, endMs: start + 2000, bytes: 100, completedAtWallMs: WALL0 + start + 2000,
        };
        ring.add(seg);
        timeSync.onSegment(seg);
        out.push(seg);
      }
      clock.now = Math.max(clock.now, WALL0 + toMs);
      return out;
    },
    /** Whether the segment starting at `startMs` survives a cleanup far in the future. */
    async survives(epoch: number, startMs: number): Promise<boolean> {
      const saved = clock.now;
      clock.now += 3_600_000;
      await ring.cleanup();
      clock.now = saved;
      return ring.select(epoch, startMs + 1, startMs + 2).length === 1;
    },
  };
  return world;
}
export type World = ReturnType<typeof makeWorld>;
