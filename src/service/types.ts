export type Trigger = 'laugh' | 'reaction' | 'audio' | 'manual' | 'mass'; // 'mass' only on old records
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
  scores: { total: number; share: number; speed: number; audio: number };
  signals: {
    chatSpike: number;
    /** Absent on clips recorded before the relative chat trigger. Since the spike-then-composition
     *  rule: the share of trigger messages in the window; before it: the share of active authors. */
    triggerShare?: number;
    triggerMessages?: number;
    /** Messages in the window; absent on clips recorded before the spike-then-composition rule. */
    messages?: number;
    /** Present only on clips of the older rule (triggerShare is then a share of active authors). */
    activeAuthors?: number;
    laughShare: number; reactionShare: number; deltaDb: number };
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
  profileId: string | null;     // null: manual clip or clip made before profiles
  profileName: string | null;
}
