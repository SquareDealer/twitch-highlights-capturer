import { join } from 'node:path';
import type { CaptureSession } from '@shared/types';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const MAX_SLUG_LENGTH = 60;

/** Title → file-system-safe name valid on Windows. Keeps Unicode letters and digits; empty → 'clip'. */
export function slugify(title: string): string {
  const trimDashes = (s: string) => s.replace(/^-+|-+$/g, '');
  let slug = String(title)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\p{M}-]/gu, '')
    .replace(/-+/g, '-');
  slug = trimDashes(slug);
  slug = trimDashes([...slug].slice(0, MAX_SLUG_LENGTH).join(''));
  if (!slug) return 'clip';
  return RESERVED.test(slug) ? `clip-${slug}` : slug;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Local time, `2026-11-14_18-30`. */
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const safeToken = (s: string, fallback: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '') || fallback;

export function sessionFolderName(streamId: string, startedAt: Date): string {
  return `${safeToken(streamId, 'unknown')}_${stamp(startedAt)}`;
}

export function clipFolderName(createdAt: Date, slug: string, clipId: string): string {
  const hex = clipId.toLowerCase().replace(/[^0-9a-f]/g, '');
  return `${stamp(createdAt)}_${slug}_${hex.slice(-4).padStart(4, '0')}`;
}

export function clipPaths(
  libraryDir: string,
  session: Pick<CaptureSession, 'streamer' | 'streamId' | 'startedAt'>,
  createdAt: Date,
  title: string,
  clipId: string,
): { dir: string; mp4Path: string; markersPath: string; slug: string } {
  const slug = slugify(title);
  const dir = join(
    libraryDir,
    safeToken(session.streamer, 'unknown'),
    sessionFolderName(session.streamId, new Date(session.startedAt)),
    clipFolderName(createdAt, slug, clipId),
  );
  return { dir, mp4Path: join(dir, `${slug}.mp4`), markersPath: join(dir, 'markers.json'), slug };
}
