import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureSession, CaptureStatus, DriveStatus, Moment, Result, Settings, ThrEvents, ThrHandlers, UiState } from '@shared/types';
import { createProcessRunner, type ProcessRunner } from './capture/processes';
import { RingBufferManager } from './capture/ringBuffer';
import { CaptureSessionManager } from './capture/sessionManager';
import { TimeSynchronizer } from './capture/timeSync';
import { openDb } from './db';
import { createRepos } from './db/repos';
import { Exporter, type EncodeFn, type ExportJob } from './export/exporter';
import type { HotkeyAction } from './hotkeys';
import { JobQueue } from './jobs/jobQueue';
import { DraftService, type ConcatFn } from './moments/draftService';
import { MomentService } from './moments/momentService';
import { defaultSettings, SettingsStore } from './settings';

/** Google Drive integration as seen by the app; the real implementation is plugged in by `createDriveSync`. */
export interface DriveFacade {
  status(): Promise<DriveStatus>;
  connect(): Promise<Result<null>>;
  disconnect(): Promise<void>;
  /** A clip was saved locally (auto-sync decides whether to upload). */
  onClipSaved(clipId: string): void;
  sync(clipId: string): void;
  syncAll(): void;
  start(): void;
  stop(): Promise<void>;
}

export interface AppOptions {
  dbFile: string;
  userDataDir: string;
  videosDir: string;
  send: <K extends keyof ThrEvents>(event: K, payload: ThrEvents[K]) => void;
  /** Origin of the local HTTP server that serves draft videos. */
  mediaOrigin: () => string;
  showItemInFolder?: (path: string) => void;
  createDrive?: (ctx: { repos: ReturnType<typeof createRepos>; settings: SettingsStore; userDataDir: string; notify: (n: ThrEvents['notice']) => void; clipsChanged: () => void }) => DriveFacade;
  /** How long shutdown waits for a running export before leaving it to be resumed on next start. */
  shutdownTimeoutMs?: number;
  overrides?: { runner?: ProcessRunner; concat?: ConcatFn; encode?: EncodeFn; sleep?: (ms: number) => Promise<void>; pollMs?: number };
}

const noDrive: DriveFacade = {
  status: async () => ({ connected: false }),
  connect: async () => ({ ok: false, error: 'Укажите Client ID и Client Secret в настройках' }),
  disconnect: async () => undefined,
  onClipSaved: () => undefined,
  sync: () => undefined,
  syncAll: () => undefined,
  start: () => undefined,
  stop: async () => undefined,
};

/** Settings the UI may change, with the allowed range for numbers. */
const EDITABLE_SETTINGS: Partial<Record<keyof Settings, 'path' | 'text' | 'latency' | 'boolean'>> = {
  libraryDir: 'path',
  streamlinkPath: 'path',
  ffmpegPath: 'path',
  quality: 'path',
  lastChannel: 'text',
  driveClientId: 'text',
  driveClientSecret: 'text',
  captureLatencyMs: 'latency',
  defaultEmbedLatencyMs: 'latency',
  markerOffsetMs: 'latency',
  driveAutoSync: 'boolean',
};
const LATENCY_LIMIT_MS = 60_000;

function sanitizeSettings(patch: unknown): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, value] of Object.entries(patch)) {
    const kind = EDITABLE_SETTINGS[key as keyof Settings];
    if (key === 'driveClientSecret' && value === '') continue; // the secret is never echoed to the UI, so an empty value means "unchanged"
    if (kind === 'path' && typeof value === 'string' && value.trim()) out[key] = value.trim();
    else if (kind === 'text' && typeof value === 'string') out[key] = value.trim();
    else if (kind === 'latency' && Number.isInteger(value) && Math.abs(value as number) <= LATENCY_LIMIT_MS) out[key] = value;
    else if (kind === 'boolean' && typeof value === 'boolean') out[key] = value;
  }
  return out as Partial<Settings>;
}

/**
 * Composition root of the main process, free of Electron APIs so it can be exercised in tests.
 * `api` backs the renderer's `window.thr`; `handleHotkey` backs the keyboard shortcuts.
 */
export function createApp(opts: AppOptions) {
  const db = openDb(opts.dbFile);
  const repos = createRepos(db);
  const settings = new SettingsStore(db, defaultSettings({ videos: opts.videosDir, userData: opts.userDataDir }));
  const draftsDir = join(opts.userDataDir, 'drafts');
  const o = opts.overrides ?? {};
  const send = opts.send;
  const notify = (level: ThrEvents['notice']['level'], message: string) => send('notice', { level, message });

  let ui: UiState = { mode: 'watch', textInputFocused: false };
  let statusTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const ring = new RingBufferManager({
    segments: repos.segments,
    retentionMs: settings.get().bufferSeconds * 1000,
    maxPinnedBytes: settings.get().maxPinnedBytes,
  });
  const timeSync = new TimeSynchronizer(() => settings.get());
  const currentSession = (): CaptureSession | null => sessionManager.current();
  const moments = new MomentService({ repos, ring, timeSync, currentSession, settings });
  const drafts = new DraftService({
    repos, ring, timeSync, moments, currentSession, settings, draftsDir,
    concat: o.concat,
    sleep: o.sleep,
  });
  const sessionManager: CaptureSessionManager = new CaptureSessionManager({
    runner: o.runner ?? createProcessRunner(() => settings.get()),
    ring, timeSync, settings,
    sessions: repos.sessions,
    sleep: o.sleep,
    pollMs: o.pollMs,
    beforeStop: async (session) => {
      await drafts.whenIdle(); // a replay requested just before the stop still needs the buffer
      await drafts.createFromMarkers(session.id);
    },
    replay: async () => {
      const r = await drafts.captureReplay();
      if (!r.ok) throw new Error(r.error);
      return r.value.id;
    },
  });
  const exporter = new Exporter({ repos, moments, drafts, settings, encode: o.encode });
  const exportQueue = new JobQueue<ExportJob>(db, 'export', (job) => exporter.handle(job), {
    maxAttempts: 1,
    backoffMs: () => 0,
    onFailed: (job, error) => exporter.onFailed(job, error),
  });
  const drive = opts.createDrive?.({ repos, settings, userDataDir: opts.userDataDir, notify: (n) => send('notice', n), clipsChanged: () => send('clips:changed', null) }) ?? noDrive;

  const activeMoment = (): Moment | null => {
    const session = sessionManager.current();
    return session ? repos.moments.activeFor(session.id) : null;
  };
  const status = (): CaptureStatus => ({
    session: sessionManager.current(),
    bufferedMs: Math.min(ring.bufferedMs(), settings.get().bufferSeconds * 1000),
    pinnedBytes: ring.pinnedBytes(),
    markerCount: activeMoment()?.markers.length ?? 0,
  });
  const sendStatus = () => {
    if (!shuttingDown) send('capture:status', status());
  };

  sessionManager.on('state', (session: CaptureSession | null) => {
    if (session?.state === 'RECORDING') moments.ensureActive(session.id);
    sendStatus();
  });
  ring.on('segment', sendStatus);
  ring.on('pinLimit', () => notify('warn', 'Временное хранилище превысило лимит — сохраните или удалите черновики'));
  moments.on('changed', () => {
    send('moment:changed', activeMoment());
    sendStatus();
  });
  drafts.on('changed', () => send('drafts:changed', null));
  exporter.on('saved', (clip) => {
    send('clips:changed', null);
    notify('info', `Клип сохранён: ${clip.title || 'без названия'}`);
    drive.onClipSaved(clip.id);
  });
  exporter.on('failed', ({ error }: { error: string }) => {
    send('clips:changed', null);
    notify('error', `Не удалось сохранить клип: ${error}`);
  });

  async function replay(): Promise<string | null> {
    notify('info', 'Сохраняю повтор…');
    const r = await drafts.captureReplay();
    if (!r.ok) {
      notify('warn', r.error);
      return null;
    }
    notify('info', 'Черновик сохранён');
    return r.value.id;
  }

  async function toggleEditor(): Promise<void> {
    if (ui.mode === 'editor') return send('nav', { view: 'watch' });
    let draftId = activeMoment()?.draftId ?? null;
    if (!draftId) {
      draftId = sessionManager.current() ? await replay() : (drafts.list().at(-1)?.id ?? null);
      if (!draftId && !sessionManager.current()) notify('warn', 'Черновиков нет — нажмите F8 во время просмотра');
    }
    if (draftId) send('nav', { view: 'editor', draftId });
  }

  function handleHotkey(action: HotkeyAction, wallMs: number): void {
    switch (action.kind) {
      case 'marker': {
        const r = moments.addMarker(action.type, wallMs);
        if (r.ok) send('marker:prompt', r.value);
        else notify('warn', r.error);
        return;
      }
      case 'replay':
        if (!sessionManager.current()) return notify('warn', 'Буфер пуст — нечего сохранять');
        void replay().catch((e: Error) => notify('error', e.message));
        return;
      case 'toggleEditor':
        void toggleEditor().catch((e: Error) => notify('error', e.message));
        return;
      case 'save':
        send('editor:save', null);
        return;
    }
  }

  const api: ThrHandlers = {
    capture: {
      async start(channel) {
        await sessionManager.start(String(channel ?? ''));
        const session = sessionManager.current();
        if (session && session.state !== 'ERROR') settings.set({ lastChannel: session.streamer });
      },
      stop: () => sessionManager.stop(),
      status: async () => status(),
    },
    player: {
      async reportLatency(ms) {
        timeSync.reportEmbedLatency(typeof ms === 'number' ? ms : null);
      },
    },
    ui: {
      async setState(s) {
        const mode = s?.mode === 'watch' || s?.mode === 'editor' ? s.mode : 'other';
        ui = { mode, textInputFocused: Boolean(s?.textInputFocused) };
      },
    },
    markers: {
      async setComment(id, comment) {
        moments.setComment(String(id), String(comment ?? ''));
      },
      async update(id, patch) {
        moments.updateMarker(String(id), patch ?? {});
      },
      async remove(id) {
        moments.removeMarker(String(id));
      },
    },
    moment: {
      active: async () => activeMoment(),
      async discardActive() {
        const session = sessionManager.current();
        if (session) moments.discardActive(session.id);
      },
    },
    drafts: {
      list: async () => drafts.list(),
      async open(id) {
        const draftId = id ?? activeMoment()?.draftId ?? drafts.list().at(-1)?.id ?? null;
        const draft = draftId ? repos.drafts.get(String(draftId)) : null;
        if (!draft) return null;
        const moment = repos.moments.forDraft(draft.id) ?? moments.ensureActive(draft.sessionId);
        return { draft, moment, mediaUrl: `${opts.mediaOrigin()}/media/drafts/${draft.id}.mp4?v=${draft.startMs}-${draft.endMs}` };
      },
      extend: (id, by) => drafts.extend(String(id), { beforeMs: Number(by?.beforeMs) || 0, afterMs: Number(by?.afterMs) || 0 }),
      discard: (id) => drafts.discard(String(id)),
    },
    clips: {
      async export(req) {
        const r = exporter.request(req);
        if (!r.ok) return r;
        exportQueue.enqueue(r.value);
        void exportQueue.tick().catch(() => undefined);
        return { ok: true, value: { clipId: r.value.clipId } };
      },
      list: async () => repos.clips.list(),
      failed: async () => repos.moments.listByStatus('FAILED').filter((m) => m.draftId !== null && repos.drafts.get(m.draftId) !== null),
      async showInFolder(id) {
        const clip = repos.clips.get(String(id));
        if (clip) opts.showItemInFolder?.(clip.mp4Path);
      },
      async sync(id) {
        drive.sync(String(id));
      },
      async syncAll() {
        drive.syncAll();
      },
    },
    drive: {
      status: () => drive.status(),
      connect: () => drive.connect(),
      disconnect: () => drive.disconnect(),
    },
    settings: {
      // The Drive client secret is write-only for the window: third-party player code runs in that page.
      get: async () => ({ ...settings.get(), driveClientSecret: '' }),
      set: async (patch) => ({ ...settings.set(sanitizeSettings(patch)), driveClientSecret: '' }),
    },
  };

  /** Startup housekeeping: raw segments never survive a restart, drafts and their markers do. */
  async function start(): Promise<void> {
    const { bufferDir } = settings.get();
    await mkdir(bufferDir, { recursive: true });
    for (const entry of await readdir(bufferDir)) await rm(join(bufferDir, entry), { recursive: true, force: true });
    await mkdir(draftsDir, { recursive: true });
    repos.segments.clear();
    db.prepare("UPDATE capture_sessions SET state = 'IDLE', ended_at = COALESCE(ended_at, ?) WHERE state != 'IDLE'").run(new Date().toISOString());
    for (const draft of repos.drafts.list()) {
      if (!existsSync(draft.filePath)) {
        repos.drafts.remove(draft.id);
        repos.moments.clearDraft(draft.id);
      }
    }
    // A session's ACTIVE moment holds the markers of all of its drafts, not only of `draftId` (the latest F8),
    // so it is closed only when the session has no draft left: then its footage is really gone.
    const sessionsWithDrafts = new Set(repos.drafts.list().map((d) => d.sessionId));
    for (const m of repos.moments.listByStatus('ACTIVE')) {
      if (!sessionsWithDrafts.has(m.streamSessionId)) repos.moments.setStatus(m.id, 'DISCARDED');
    }
    for (const m of repos.moments.listByStatus('FAILED')) if (!m.draftId) repos.moments.setStatus(m.id, 'DISCARDED');
    exportQueue.recover();
    exportQueue.start(500);
    drive.start();
    statusTimer = setInterval(sendStatus, 1000);
    statusTimer.unref?.();
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    if (statusTimer) clearInterval(statusTimer);
    await sessionManager.stop().catch(() => undefined);
    shuttingDown = true;
    // A long encode or a stalled upload must not keep the process (and the single-instance lock) alive:
    // unfinished jobs are picked up again on the next start.
    exportQueue.stopPolling();
    await Promise.race([exportQueue.whenIdle(), new Promise((r) => setTimeout(r, opts.shutdownTimeoutMs ?? 10_000))]);
    await drive.stop();
    db.close();
  }

  return { api, handleHotkey, getUi: () => ui, status, start, shutdown, repos, settings };
}

export type App = ReturnType<typeof createApp>;
