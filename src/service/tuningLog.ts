import type { DetectorSignals } from './detectorProcess';
import type { DetectorEvent, Trigger } from './types';

export type TuningEntry =
  | { at: string; kind: 'nearmiss'; missing: string[]; values: Record<string, number> }
  | { at: string; kind: 'clip'; clipId: string; triggers: Trigger[]; scores: DetectorEvent['scores'] }
  | { at: string; kind: 'limited'; scores: DetectorEvent['scores']; limit: number; median: number }
  | { at: string; kind: 'paused'; scores: DetectorEvent['scores']; reason: string }
  | { at: string; kind: 'profile'; name: string; version: number; badPatterns: string[]; error?: string };

export const MAX_FRAMES = 300;
export const MAX_ENTRIES = 100;

function push<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/** Recent detector frames and tuning-relevant entries of one stream, for the tuning panel. */
export class TuningLog {
  private readonly frames: DetectorSignals[] = [];
  private readonly entries: TuningEntry[] = [];

  addFrame(s: DetectorSignals): void {
    push(this.frames, s, MAX_FRAMES);
  }

  addEntry(e: TuningEntry): void {
    push(this.entries, e, MAX_ENTRIES);
  }

  /** Oldest first; the arrays are copies. */
  snapshot(): { frames: DetectorSignals[]; entries: TuningEntry[] } {
    return { frames: [...this.frames], entries: [...this.entries] };
  }
}
