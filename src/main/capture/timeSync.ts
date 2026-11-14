import type { Segment, Settings, SourceTime } from '@shared/types';

type SyncSettings = Pick<Settings, 'captureLatencyMs' | 'defaultEmbedLatencyMs' | 'markerOffsetMs'>;

const EMBED_LATENCY_MAX_MS = 60_000;
const EMBED_LATENCY_TTL_MS = 10_000;

/**
 * Maps wall-clock time to the capture timeline.
 * offset(epoch) = min(completedAtWallMs − endMs) over the epoch's segments, i.e. the wall time of source time 0.
 * A marker is shifted back by how far the Twitch Embed lags behind what Streamlink has already received.
 */
export class TimeSynchronizer {
  private epoch: number | null = null;
  private offsetMs = 0;
  private embedLatency: { ms: number; at: number } | null = null;

  constructor(private readonly getSettings: () => SyncSettings, private readonly now: () => number = Date.now) {}

  onSegment(seg: Pick<Segment, 'epoch' | 'endMs' | 'completedAtWallMs'>): void {
    const offset = seg.completedAtWallMs - seg.endMs;
    if (this.epoch === null || seg.epoch > this.epoch) {
      this.epoch = seg.epoch;
      this.offsetMs = offset;
    } else if (seg.epoch === this.epoch) {
      this.offsetMs = Math.min(this.offsetMs, offset);
    }
  }

  reportEmbedLatency(ms: number | null): void {
    const valid = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= EMBED_LATENCY_MAX_MS;
    this.embedLatency = valid ? { ms: ms as number, at: this.now() } : null;
  }

  captureNow(wallMs: number): SourceTime | null {
    if (this.epoch === null) return null;
    return { epoch: this.epoch, sourceTimeMs: Math.max(0, Math.round(wallMs - this.offsetMs)) };
  }

  markerTime(wallMs: number): SourceTime | null {
    if (this.epoch === null) return null;
    const s = this.getSettings();
    const fresh = this.embedLatency && this.now() - this.embedLatency.at <= EMBED_LATENCY_TTL_MS;
    const embedLatencyMs = fresh ? this.embedLatency!.ms : s.defaultEmbedLatencyMs;
    const t = wallMs - this.offsetMs - (embedLatencyMs - s.captureLatencyMs) + s.markerOffsetMs;
    return { epoch: this.epoch, sourceTimeMs: Math.max(0, Math.round(t)) };
  }

  reset(): void {
    this.epoch = null;
    this.offsetMs = 0;
    this.embedLatency = null;
  }
}
