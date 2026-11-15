import { join } from 'node:path';
import type { CaptureSession } from '@shared/types';
import { sessionFolderName } from '../main/export/paths';
import type { Trigger } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local time, `2026-11-14_18-30-05`. */
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const safeToken = (s: string, fallback: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '') || fallback;

/** `<library>/<channel>/<streamId>_<date>/<YYYY-MM-DD_HH-mm-ss>_<triggers>_<last 4 hex of id>.mp4|.json` */
export function feedClipPaths(
  libraryDir: string,
  s: Pick<CaptureSession, 'streamer' | 'streamId' | 'startedAt'>,
  createdAt: Date,
  triggers: Trigger[],
  clipId: string,
): { dir: string; mp4Path: string; jsonPath: string } {
  const dir = join(libraryDir, safeToken(s.streamer, 'unknown'), sessionFolderName(s.streamId, new Date(s.startedAt)));
  const hex = clipId.toLowerCase().replace(/[^0-9a-f]/g, '').slice(-4).padStart(4, '0');
  const base = `${stamp(createdAt)}_${triggers.join('+') || 'clip'}_${hex}`;
  return { dir, mp4Path: join(dir, `${base}.mp4`), jsonPath: join(dir, `${base}.json`) };
}
