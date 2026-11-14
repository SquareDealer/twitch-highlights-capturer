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
