import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { toClipMarkers } from '@shared/time';
import type { Clip, ExportRequest, Result } from '@shared/types';
import type { Repos } from '../db/repos';
import type { DraftService } from '../moments/draftService';
import type { MomentService } from '../moments/momentService';
import type { SettingsStore } from '../settings';
import { clipPaths } from './paths';

export interface ExportJob {
  momentId: string;
  draftId: string;
  trimStartMs: number;
  trimEndMs: number;
  title: string;
  clipId: string;
}

export type EncodeFn = (a: { input: string; startMs: number; durationMs: number; output: string }) => Promise<void>;

export interface ExporterDeps {
  repos: Repos;
  moments: MomentService;
  drafts: DraftService;
  settings: SettingsStore;
  encode?: EncodeFn;
  now?: () => Date;
  newId?: () => string;
}

const MIN_CLIP_MS = 500;
const MAX_TITLE_LENGTH = 200;
const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** Frame-accurate trim: re-encodes so that the clip starts exactly at `startMs` and marker offsets stay true. */
export function encodeClip(ffmpegPath: string): EncodeFn {
  return ({ input, startMs, durationMs, output }) =>
    new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-ss', seconds(startMs), '-i', input, '-t', seconds(durationMs),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', '-y', output,
      ];
      execFile(ffmpegPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
        err ? reject(new Error(String(stderr).trim().split('\n').pop() || err.message)) : resolve(),
      );
    });
}

/**
 * Turns a draft + trim into `<slug>.mp4` and `markers.json`.
 * `request` runs synchronously on Ctrl+S (so new markers immediately go to a fresh moment);
 * `handle` is the 'export' queue handler. Emits 'saved' (Clip) and 'failed' ({ momentId, error }).
 */
export class Exporter extends EventEmitter {
  private readonly encode: EncodeFn;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: ExporterDeps) {
    super();
    this.encode = deps.encode ?? ((a) => encodeClip(deps.settings.get().ffmpegPath)(a));
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  request(req: ExportRequest): Result<ExportJob> {
    const draft = this.deps.repos.drafts.get(String(req.draftId));
    if (!draft) return { ok: false, error: 'Черновик не найден' };
    if (!existsSync(draft.filePath)) return { ok: false, error: 'Файл черновика не найден' };
    if (!Number.isFinite(req.trimStartMs) || !Number.isFinite(req.trimEndMs)) return { ok: false, error: 'Некорректные границы обрезки' };
    const length = draft.endMs - draft.startMs;
    const clamp = (v: number) => Math.min(length, Math.max(0, Math.round(v)));
    const trimStartMs = clamp(req.trimStartMs);
    const trimEndMs = clamp(req.trimEndMs);
    if (trimEndMs - trimStartMs < MIN_CLIP_MS) return { ok: false, error: 'Клип короче 0,5 секунды' };
    const moment = this.deps.moments.beginExport(draft);
    const title = String(req.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
    return { ok: true, value: { momentId: moment.id, draftId: draft.id, trimStartMs, trimEndMs, title, clipId: this.newId() } };
  }

  async handle(job: ExportJob): Promise<void> {
    const { repos, settings } = this.deps;
    const draft = repos.drafts.get(job.draftId);
    const moment = repos.moments.get(job.momentId);
    if (!draft || !moment) throw new Error('Черновик не найден');
    const session = repos.sessions.get(draft.sessionId) ?? { streamer: 'unknown', streamId: 'unknown', streamTitle: '', startedAt: draft.createdAt };
    const createdAt = this.now();
    const paths = clipPaths(settings.get().libraryDir, session, createdAt, job.title, job.clipId);
    const durationMs = job.trimEndMs - job.trimStartMs;
    const clip: Clip = {
      id: job.clipId, momentId: moment.id, sessionId: draft.sessionId, title: job.title, dir: paths.dir, mp4Path: paths.mp4Path,
      markersPath: paths.markersPath, durationMs, createdAt: createdAt.toISOString(), syncStatus: 'pending',
    };
    const markersFile = {
      version: 1,
      clipId: clip.id,
      title: clip.title,
      streamer: session.streamer,
      streamId: session.streamId,
      streamTitle: session.streamTitle ?? '',
      createdAt: clip.createdAt,
      durationMs,
      sourceEpoch: draft.epoch,
      sourceStartMs: draft.startMs + job.trimStartMs,
      markers: toClipMarkers(moment.markers, draft, job.trimStartMs, job.trimEndMs),
    };
    try {
      await mkdir(paths.dir, { recursive: true });
      await this.encode({ input: draft.filePath, startMs: job.trimStartMs, durationMs, output: `${paths.mp4Path}.part` });
      await rename(`${paths.mp4Path}.part`, paths.mp4Path);
      await writeFile(`${paths.markersPath}.part`, `${JSON.stringify(markersFile, null, 2)}\n`, 'utf8');
      await rename(`${paths.markersPath}.part`, paths.markersPath);
    } catch (e) {
      // The folder name carries this clip's id, so everything in it is ours: leave no half-written clip behind.
      await rm(paths.dir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    repos.clips.insert(clip);
    this.deps.moments.completeExport(moment.id);
    await this.deps.drafts.discard(draft.id);
    this.emit('saved', clip);
  }

  onFailed(job: ExportJob, error: string): void {
    this.deps.moments.failExport(job.momentId);
    this.emit('failed', { momentId: job.momentId, error });
  }
}
