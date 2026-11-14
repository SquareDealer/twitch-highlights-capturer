import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CaptureSession, CaptureState } from '@shared/types';
import type { Repos } from '../db/repos';
import type { SettingsStore } from '../settings';
import { normalizeChannel, type CaptureProcs, type ProcessRunner } from './processes';
import type { RingBufferManager } from './ringBuffer';
import { SegmentListTailer, type SegmentListEntry } from './segmentList';
import type { TimeSynchronizer } from './timeSync';

export interface CaptureSessionManagerDeps {
  runner: ProcessRunner;
  ring: RingBufferManager;
  timeSync: TimeSynchronizer;
  sessions: Repos['sessions'];
  settings: SettingsStore;
  /** Runs while segments are still on disk (used to auto-build a draft from unsaved markers). */
  beforeStop?: (session: CaptureSession) => Promise<void>;
  /** F8 implementation; returns the id of the created draft. */
  replay?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

const RETRY_DELAYS_MS = [2000, 5000, 10_000, 30_000];
const CLEANUP_INTERVAL_MS = 5000;

/**
 * Owns the single capture session: one Streamlink and one FFmpeg process at a time.
 * Every (re)connection starts a new epoch with its own directory and its own timeline.
 * Emits 'state' with a CaptureSession snapshot (or null once stopped).
 */
export class CaptureSessionManager extends EventEmitter {
  private session: CaptureSession | null = null;
  private procs: CaptureProcs | null = null;
  private tailer: SegmentListTailer | null = null;
  private epochStartSec: number | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Bumped whenever the running capture is superseded; stale async continuations check it and bail out. */
  private generation = 0;
  private stopping: Promise<void> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: CaptureSessionManagerDeps) {
    super();
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  current(): CaptureSession | null {
    return this.session ? { ...this.session } : null;
  }

  async start(channel: string): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.session) await this.stop();
    const gen = ++this.generation;
    const session: CaptureSession = {
      id: randomUUID(),
      streamer: normalizeChannel(channel) ?? channel.trim(),
      streamId: '',
      state: 'CONNECTING',
      startedAt: new Date(this.now()).toISOString(),
      epoch: 0,
    };
    this.session = session;
    this.emitState();

    const binariesError = await this.deps.runner.checkBinaries();
    if (gen !== this.generation) return;
    if (binariesError) return this.fail(binariesError);
    const name = normalizeChannel(channel);
    if (!name) return this.fail('Некорректное имя канала');
    let probe;
    try {
      probe = await this.deps.runner.probe(name);
    } catch (e) {
      probe = { live: false as const, reason: (e as Error).message };
    }
    if (gen !== this.generation) return;
    if (!probe.live) return this.fail('Канал не в эфире');

    session.streamId = probe.streamId;
    this.deps.sessions.insert(session);
    this.cleanupTimer = setInterval(() => void this.deps.ring.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
    this.spawnEpoch(gen);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.session) return Promise.resolve();
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** Forces an immediate reconnect into a new epoch. */
  async reconnect(): Promise<void> {
    const s = this.session;
    if (!s || this.stopping || !['CONNECTING', 'RECORDING', 'RECONNECTING'].includes(s.state)) return;
    const gen = ++this.generation;
    await this.teardownProcs();
    if (gen !== this.generation) return;
    await this.reconnectLoop(gen, true);
  }

  async captureReplay(): Promise<string> {
    if (!this.deps.replay) throw new Error('Повтор недоступен');
    return this.deps.replay();
  }

  private async doStop(): Promise<void> {
    const session = this.session!;
    this.generation++;
    const persisted = session.streamId !== '' || this.deps.sessions.get(session.id) !== null;
    this.setState('STOPPING');
    try {
      this.tailer?.poll();
      await this.deps.beforeStop?.({ ...session });
    } catch {
      /* a failed auto-draft must not block shutdown */
    }
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.teardownProcs();
    await this.deps.ring.clearAll();
    this.deps.timeSync.reset();
    await rm(join(this.deps.settings.get().bufferDir, session.id), { recursive: true, force: true }).catch(() => undefined);
    if (persisted) this.deps.sessions.update(session.id, { state: 'IDLE', endedAt: new Date(this.now()).toISOString() });
    this.session = null;
    this.emit('state', null);
  }

  private async teardownProcs(): Promise<void> {
    this.tailer?.stop();
    this.tailer = null;
    const procs = this.procs;
    this.procs = null;
    if (procs) await procs.stop().catch(() => undefined);
  }

  private spawnEpoch(gen: number): void {
    const session = this.session!;
    const epoch = session.epoch;
    const epochDir = join(this.deps.settings.get().bufferDir, session.id, `e${epoch}`);
    mkdirSync(epochDir, { recursive: true });
    this.epochStartSec = null;
    const tailer = new SegmentListTailer(join(epochDir, 'segments.csv'), (e) => this.onSegment(gen, epoch, epochDir, e), this.deps.pollMs ?? 250);
    this.tailer = tailer;
    tailer.start();
    const procs = this.deps.runner.spawnCapture(session.streamer, epochDir);
    this.procs = procs;
    procs.onExit(() => {
      if (gen !== this.generation) return;
      tailer.poll(); // pick up segments finished right before the exit
      this.generation++;
      const next = this.generation;
      void this.teardownProcs().then(() => this.reconnectLoop(next, false));
    });
  }

  private onSegment(gen: number, epoch: number, epochDir: string, entry: SegmentListEntry): void {
    const session = this.session;
    if (gen !== this.generation || !session) return;
    this.epochStartSec ??= entry.startSec;
    const path = join(epochDir, basename(entry.file));
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      /* size is informational only */
    }
    const seq = Number(/(\d+)\.ts$/.exec(entry.file)?.[1] ?? 0);
    const segment = {
      sessionId: session.id,
      epoch,
      seq,
      path,
      startMs: Math.round((entry.startSec - this.epochStartSec) * 1000),
      endMs: Math.round((entry.endSec - this.epochStartSec) * 1000),
      bytes,
      completedAtWallMs: this.now(),
    };
    this.deps.ring.add(segment);
    this.deps.timeSync.onSegment(segment);
    void this.deps.ring.cleanup();
    if (session.state !== 'RECORDING') this.setState('RECORDING');
  }

  private async reconnectLoop(gen: number, immediate: boolean): Promise<void> {
    if (gen !== this.generation || !this.session) return;
    this.session.epoch += 1;
    this.deps.sessions.update(this.session.id, { epoch: this.session.epoch });
    this.setState('RECONNECTING');
    for (let attempt = 0; ; attempt++) {
      if (!(immediate && attempt === 0)) {
        const delayIndex = immediate ? attempt - 1 : attempt;
        await this.sleep(RETRY_DELAYS_MS[Math.min(delayIndex, RETRY_DELAYS_MS.length - 1)]!);
        if (gen !== this.generation) return;
      }
      let live = false;
      try {
        live = (await this.deps.runner.probe(this.session!.streamer)).live;
      } catch {
        live = false;
      }
      if (gen !== this.generation) return;
      if (live) {
        this.spawnEpoch(gen);
        return;
      }
    }
  }

  private fail(message: string): void {
    if (!this.session) return;
    this.session.error = message;
    this.setState('ERROR');
  }

  private setState(state: CaptureState): void {
    if (!this.session) return;
    this.session.state = state;
    if (this.deps.sessions.get(this.session.id)) {
      this.deps.sessions.update(this.session.id, { state, ...(this.session.error ? { error: this.session.error } : {}) });
    }
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.current());
  }
}
