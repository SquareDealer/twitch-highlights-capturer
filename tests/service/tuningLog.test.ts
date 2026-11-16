import type { DetectorSignals } from '../../src/service/detectorProcess';
import { MAX_ENTRIES, MAX_FRAMES, TuningLog, type TuningEntry } from '../../src/service/tuningLog';

const frame = (tMs: number): DetectorSignals => ({ tMs, chatSpike: 0, laughShare: 0, messages: 0, deltaDb: 0, vad: 0, warm: true });
const entry = (n: number): TuningEntry => ({ at: `t${n}`, kind: 'nearmiss', missing: ['share'], values: { n } });

it('keeps the last 300 frames and 100 entries, oldest first', () => {
  expect(MAX_FRAMES).toBe(300);
  expect(MAX_ENTRIES).toBe(100);
  const log = new TuningLog();
  for (let i = 0; i < 350; i++) log.addFrame(frame(i));
  for (let i = 0; i < 130; i++) log.addEntry(entry(i));
  const s = log.snapshot();
  expect(s.frames).toHaveLength(300);
  expect(s.frames[0]!.tMs).toBe(50);
  expect(s.frames.at(-1)!.tMs).toBe(349);
  expect(s.entries).toHaveLength(100);
  expect(s.entries[0]!.at).toBe('t30');
  expect(s.entries.at(-1)!.at).toBe('t129');
});

it('snapshot returns copies', () => {
  const log = new TuningLog();
  log.addFrame(frame(1));
  log.addEntry(entry(1));
  const s = log.snapshot();
  s.frames.push(frame(2));
  s.entries.length = 0;
  log.addFrame(frame(3));
  expect(s.frames.map((f) => f.tMs)).toEqual([1, 2]);
  expect(log.snapshot().frames.map((f) => f.tMs)).toEqual([1, 3]);
  expect(log.snapshot().entries).toHaveLength(1);
});
