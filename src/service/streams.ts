import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { CaptureSession, CaptureState, Result } from '@shared/types';
import type { ConcatFn } from '../main/capture/concat';
import { createProcessRunner, type ProcessRunner } from '../main/capture/processes';
import { RingBufferManager } from '../main/capture/ringBuffer';
import { CaptureSessionManager } from '../main/capture/sessionManager';
import type { Db } from '../main/db';
import { createRepos, type Repos } from '../main/db/repos';
import { createClipRepo } from './clipRepo';
import { saveConfigPatch, type ServiceConfig } from './config';
import { Cutter } from './cutter';
import { settingsFromConfig } from './profileSettings';
import { DetectorProcess, type DetectorHealth, type DetectorSignals } from './detectorProcess';
import { appendNearMiss } from './nearMissLog';
import type { DetectorEvent, FeedClip } from './types';

export interface StreamStatus {
  id: string;
  channel: string;
  quality: string;
  state: CaptureState;
  error?: string;
  startedAt: string;
  bufferedMs: number;
  clipsCreated: number;
  detector: DetectorHealth;
  signals: DetectorSignals | null;
}

export interface StreamRegistryDeps {
  db: Db;
  config: () => ServiceConfig;
  configFile: string;
  cuttingPaused: () => boolean;
  runner?: ProcessRunner;
  makeDetector?: (channel: string) => DetectorProcess;
  concat?: ConcatFn;
  /** Test seams for the capture managers. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
}

const NOT_A_CHANNEL = 'Это не ссылка на канал Twitch';
const ALREADY_RECORDING = 'Этот канал уже записывается';
const LEAVE_MULTI_FIRST = 'Сначала остановите лишние эфиры: в режиме «один эфир» может идти только один';
const limitReached = (n: number, multiStream: boolean) =>
  multiStream
    ? `Достигнут лимит одновременных эфиров (${n}). Остановите один из эфиров`
    : `Достигнут лимит одновременных эфиров (${n}). Остановите один из эфиров или включите режим «несколько эфиров»`;

const MAX_PINNED_BYTES = 2 * 1024 ** 3;
const STATUS_INTERVAL_MS = 1000;

/** First path segments of twitch.tv that are not channels. */
const RESERVED_PATHS = new Set([
  'videos', 'directory', 'settings', 'p', 'downloads', 'jobs', 'turbo', 'search', 'subscriptions', 'inventory',
  'wallet', 'drops', 'friends', 'messages', 'login', 'signup', 'logout', 'privacy', 'prime', 'store', 'products',
  'team', 'popout', 'embed', 'moderator', 'broadcast', 'u', 'clip', 'clips', 'collections', 'following', 'bits',
]);

/** 'https://www.twitch.tv/Foo_Bar/?x' → 'foo_bar'. Only channel links are accepted, not bare logins or VODs. */
export function parseChannelUrl(input: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(input.trim());
  if (!m) return null;
  const login = m[1]!.toLowerCase();
  if (RESERVED_PATHS.has(login) || !/^[a-z0-9_]{1,25}$/.test(login)) return null;
  return login;
}

interface Stream {
  channel: string;
  quality: string;
  manager: CaptureSessionManager;
  ring: RingBufferManager;
  detector: DetectorProcess;
  cutter: Cutter;
  session: CaptureSession;
  signals: DetectorSignals | null;
  newClips: Set<string>;
}

/**
 * All streams being recorded. Each one owns a capture manager, a ring buffer (in <bufferDir>/<sessionId>),
 * a detector process and a cutter. Events: 'streams' (StreamStatus[], at most once per second),
 * 'clip' (FeedClip), 'notice' (Notice).
 */
export class StreamRegistry extends EventEmitter {
  private readonly streams = new Map<string, Stream>();
  private readonly repos: Repos;
  private readonly clips: ReturnType<typeof createClipRepo>;
  private readonly runner: ProcessRunner;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatusAt = 0;

  constructor(private readonly deps: StreamRegistryDeps) {
    super();
    this.repos = createRepos(deps.db);
    this.clips = createClipRepo(deps.db);
    this.runner = deps.runner ?? createProcessRunner(() => deps.config());
    // Rows left over from a previous run point at buffers that no longer exist.
    this.repos.segments.clear();
  }

  async probe(url: string): Promise<Result<{ channel: string; qualities: string[] }>> {
    const channel = parseChannelUrl(url);
    if (!channel) return { ok: false, error: NOT_A_CHANNEL };
    try {
      const r = await this.runner.probe(channel);
      return r.live ? { ok: true, value: { channel, qualities: r.qualities } } : { ok: false, error: 'Канал не в эфире' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async start(url: string, quality: string): Promise<Result<StreamStatus>> {
    const channel = parseChannelUrl(url);
    if (!channel) return { ok: false, error: NOT_A_CHANNEL };
    if ([...this.streams.values()].some((s) => s.channel === channel)) return { ok: false, error: ALREADY_RECORDING };
    const { limit, multiStream } = this.mode();
    if (this.streams.size >= limit) return { ok: false, error: limitReached(limit, multiStream) };

    const stream = this.create(channel, quality);
    const started = stream.manager.start(channel, { quality, pcm: true });
    // The session exists synchronously once start() is called; registering it now blocks duplicates.
    stream.session = stream.manager.current()!;
    this.streams.set(stream.session.id, stream);
    this.scheduleStatus();
    try {
      await started;
    } catch (err) {
      // Nothing may outlive a failed start: neither the capture session nor the Python process.
      await stream.manager.stop().catch(() => undefined);
      await stream.detector.stop().catch(() => undefined);
      this.remove(stream);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const session = stream.manager.current();
    if (!session || session.state === 'ERROR') {
      const error = session?.error ?? 'Запись остановлена';
      await stream.manager.stop();
      this.remove(stream);
      return { ok: false, error };
    }
    return { ok: true, value: this.status(stream) };
  }

  async stop(id: string): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream) return;
    await stream.manager.stop();
    this.remove(stream);
  }

  async manualClip(id: string): Promise<Result<FeedClip>> {
    const stream = this.streams.get(id);
    if (!stream) return { ok: false, error: 'Эфир не найден' };
    return stream.cutter.manual();
  }

  list(): StreamStatus[] {
    return [...this.streams.values()].map((s) => this.status(s));
  }

  mode(): { multiStream: boolean; limit: number } {
    const cfg = this.deps.config();
    return { multiStream: cfg.multiStream, limit: cfg.multiStream ? cfg.maxStreams : 1 };
  }

  setMultiStream(on: boolean): Result<null> {
    if (!on && this.streams.size > 1) return { ok: false, error: LEAVE_MULTI_FIRST };
    try {
      saveConfigPatch(this.deps.configFile, { multiStream: on });
    } catch (err) {
      return { ok: false, error: `Не удалось сохранить настройки: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.deps.config().multiStream = on; // the in-memory config is shared with the rest of the service
    return { ok: true, value: null };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.streams.keys()].map((id) => this.stop(id)));
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  private create(channel: string, quality: string): Stream {
    const cfg = this.deps.config();
    let manager: CaptureSessionManager | null = null;
    const ring = new RingBufferManager({
      segments: this.repos.segments,
      sessionId: () => manager?.current()?.id,
      retentionMs: cfg.bufferSeconds * 1000,
      maxPinnedBytes: MAX_PINNED_BYTES,
    });
    const detector = this.deps.makeDetector?.(channel) ?? this.defaultDetector(channel);
    const cutter = new Cutter({
      ring,
      clips: this.clips,
      config: this.deps.config,
      session: () => manager!.current() ?? stream.session,
      concat: this.deps.concat,
      paused: this.deps.cuttingPaused,
      // Placeholder: Task 7 replaces it with the stream's real profile.
      profile: () => ({ id: 'default', name: 'По умолчанию', isDefault: true, settings: settingsFromConfig(this.deps.config()), createdAt: '', updatedAt: '' }),
    });
    manager = new CaptureSessionManager({
      runner: this.runner,
      ring,
      sessions: this.repos.sessions,
      bufferDir: cfg.bufferDir,
      offlineEndMs: cfg.offlineEndMs,
      sleep: this.deps.sleep,
      pollMs: this.deps.pollMs,
      // The detector first: it flushes its open event on the stop frame, and stop() resolves only once
      // that event was emitted. Then the cutter cuts everything with the footage that exists.
      beforeStop: async () => {
        try {
          await detector.stop();
        } finally {
          await cutter.flush();
        }
      },
    });
    const stream: Stream = {
      channel, quality, manager, ring, detector, cutter,
      session: null as unknown as CaptureSession, // set right after manager.start() is called
      signals: null,
      newClips: new Set(),
    };

    manager.on('state', (s: CaptureSession | null) => {
      if (s) stream.session = s;
      else this.remove(stream);
      this.scheduleStatus();
    });
    manager.on('epoch', ({ epoch, pcm }: { epoch: number; pcm: Readable | null }) => {
      if (pcm) detector.attachPcm(pcm, epoch);
    });
    manager.on('ended', () => this.emit('notice', { level: 'info', message: `Эфир ${channel} завершился` } satisfies Notice));

    detector.on('event', (ev: DetectorEvent) => {
      // Not awaited: a clip resolves only once its tail is recorded, and events must not queue behind it.
      cutter.onEvent(ev).catch((err) => console.error(`streams: cutting failed for ${channel}`, err));
    });
    detector.on('signals', (s: DetectorSignals) => {
      stream.signals = s;
      this.scheduleStatus();
    });
    detector.on('health', () => this.scheduleStatus());
    detector.on('nearmiss', (entry: object) => {
      try {
        appendNearMiss(this.deps.config().dataDir, channel, entry);
      } catch (err) {
        console.error(`streams: cannot write near-miss for ${channel}`, err);
      }
    });

    cutter.on('clip', (clip: FeedClip) => {
      if (clip.status === 'new') stream.newClips.add(clip.id);
      this.emit('clip', clip);
      this.scheduleStatus();
    });
    cutter.on('paused', ({ reason }: { reason: string }) => this.emit('notice', { level: 'warning', message: reason } satisfies Notice));

    detector.start();
    return stream;
  }

  private defaultDetector(channel: string): DetectorProcess {
    return new DetectorProcess({
      command: this.deps.config().pythonPath,
      args: ['-m', 'hl_detector', '--channel', channel, '--config', this.deps.configFile],
      cwd: join(__dirname, '..', '..', 'detector'),
    });
  }

  private remove(stream: Stream): void {
    if (this.streams.get(stream.session.id) !== stream) return;
    this.streams.delete(stream.session.id);
    this.scheduleStatus();
  }

  private status(s: Stream): StreamStatus {
    const session = s.manager.current() ?? s.session;
    return {
      id: session.id,
      channel: s.channel,
      quality: s.quality,
      state: session.state,
      ...(session.error ? { error: session.error } : {}),
      startedAt: session.startedAt,
      bufferedMs: s.ring.bufferedMs(),
      clipsCreated: s.newClips.size,
      detector: s.detector.health(),
      signals: s.signals,
    };
  }

  private scheduleStatus(): void {
    if (this.statusTimer) return;
    const wait = Math.max(0, this.lastStatusAt + STATUS_INTERVAL_MS - Date.now());
    const send = () => {
      this.statusTimer = null;
      this.lastStatusAt = Date.now();
      this.emit('streams', this.list());
    };
    if (wait === 0) {
      send();
      return;
    }
    this.statusTimer = setTimeout(send, wait);
    this.statusTimer.unref?.();
  }
}
