export type Trigger = 'laugh' | 'mass' | 'audio' | 'manual';
export type ClipStatus = 'pending' | 'new' | 'taken' | 'rejected' | 'error';

export interface DetectorEvent {
  epoch: number;
  startMs: number;
  endMs: number;
  triggerTimeMs: number;
  estimatedEventMs: number;
  uncertaintyMs: number;
  triggers: Trigger[];
  confidence: 'normal' | 'low';
  scores: { S: number; C: number; E: number; U: number; A: number };
  signals: { chatSpike: number; laughShare: number; reactionShare: number; deltaDb: number };
}

export interface FeedClip {
  id: string;
  sessionId: string;
  streamer: string;
  streamId: string;
  epoch: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  bytes: number;
  triggers: Trigger[];
  confidence: 'normal' | 'low';
  score: number;
  signals: DetectorEvent['signals'];
  status: ClipStatus;
  error: string | null;
  mp4Path: string;
  jsonPath: string;
  fileDeleted: boolean;
  createdAt: string;
  statusChangedAt: string | null;
}
