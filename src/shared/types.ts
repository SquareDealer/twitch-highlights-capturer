export type MarkerType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type CaptureState = 'IDLE' | 'CONNECTING' | 'RECORDING' | 'RECONNECTING' | 'STOPPING' | 'ERROR';

export interface CaptureSession {
  id: string;
  streamer: string;
  streamId: string;
  state: CaptureState;
  startedAt: string;
  epoch: number;
  error?: string;
}

export interface Segment {
  sessionId: string;
  epoch: number;
  seq: number;
  path: string;
  startMs: number;
  endMs: number;
  bytes: number;
  completedAtWallMs: number;
}

export interface SourceTime {
  epoch: number;
  sourceTimeMs: number;
}

export interface Marker {
  id: string;
  momentId: string;
  epoch: number;
  type: MarkerType;
  sourceTimeMs: number;
  comment: string;
}

export type MomentStatus = 'ACTIVE' | 'EXPORTING' | 'SAVED' | 'FAILED' | 'DISCARDED';

export interface Moment {
  id: string;
  streamSessionId: string;
  status: MomentStatus;
  draftId: string | null;
  markers: Marker[];
}

export interface Draft {
  id: string;
  sessionId: string;
  epoch: number;
  startMs: number;
  endMs: number;
  filePath: string;
  createdAt: string;
}

export type SyncStatus = 'pending' | 'synced' | 'failed';

export interface Clip {
  id: string;
  momentId: string;
  sessionId: string;
  title: string;
  dir: string;
  mp4Path: string;
  markersPath: string;
  durationMs: number;
  createdAt: string;
  syncStatus: SyncStatus;
}

export interface ClipMarker {
  id: string;
  type: MarkerType;
  timeMs: number;
  comment: string;
}

export interface Settings {
  libraryDir: string;
  bufferDir: string;
  streamlinkPath: string;
  ffmpegPath: string;
  quality: string;
  lastChannel: string;
  bufferSeconds: number;
  segmentSeconds: number;
  replaySeconds: number;
  replayTailSeconds: number;
  pinBeforeMs: number;
  pinAfterMs: number;
  maxPinnedBytes: number;
  captureLatencyMs: number;
  defaultEmbedLatencyMs: number;
  markerOffsetMs: number;
  driveAutoSync: boolean;
  driveClientId: string;
  driveClientSecret: string;
}

export interface UiState {
  mode: 'watch' | 'editor' | 'other';
  textInputFocused: boolean;
}

export interface Notice {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CaptureStatus {
  session: CaptureSession | null;
  bufferedMs: number;
  pinnedBytes: number;
  markerCount: number;
}

/** Trim values are relative to the start of the draft. */
export interface ExportRequest {
  draftId: string;
  trimStartMs: number;
  trimEndMs: number;
  title: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DriveStatus {
  connected: boolean;
  email?: string;
}

export interface OpenedDraft {
  draft: Draft;
  moment: Moment;
  mediaUrl: string;
}

/** Events pushed from the main process to the renderer. */
export interface ThrEvents {
  'capture:status': CaptureStatus;
  'marker:prompt': Marker;
  'moment:changed': Moment | null;
  'drafts:changed': null;
  'clips:changed': null;
  nav: { view: 'watch' | 'editor'; draftId?: string };
  'editor:save': null;
  notice: Notice;
}

/** Everything the renderer can ask the main process to do (`window.thr`). */
export interface ThrApi {
  capture: { start(channel: string): Promise<void>; stop(): Promise<void>; status(): Promise<CaptureStatus> };
  player: { reportLatency(ms: number | null): Promise<void> };
  ui: { setState(s: UiState): Promise<void> };
  markers: {
    setComment(id: string, comment: string): Promise<void>;
    update(id: string, patch: { sourceTimeMs?: number; comment?: string; type?: MarkerType }): Promise<void>;
    remove(id: string): Promise<void>;
  };
  moment: { active(): Promise<Moment | null>; discardActive(): Promise<void> };
  drafts: {
    list(): Promise<Draft[]>;
    open(id: string | null): Promise<OpenedDraft | null>;
    extend(id: string, by: { beforeMs: number; afterMs: number }): Promise<Draft>;
    discard(id: string): Promise<void>;
  };
  clips: {
    export(req: ExportRequest): Promise<Result<{ clipId: string }>>;
    list(): Promise<Clip[]>;
    failed(): Promise<Moment[]>;
    showInFolder(id: string): Promise<void>;
    sync(id: string): Promise<void>;
    syncAll(): Promise<void>;
  };
  drive: { status(): Promise<DriveStatus>; connect(): Promise<Result<null>>; disconnect(): Promise<void> };
  settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };
  on<K extends keyof ThrEvents>(event: K, cb: (payload: ThrEvents[K]) => void): () => void;
}

export type ThrHandlers = Omit<ThrApi, 'on'>;
