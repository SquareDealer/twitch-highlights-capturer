import { join } from 'node:path';
import type { CaptureSession } from '@shared/types';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const MAX_SLUG_LENGTH = 60;
/** How many characters of the stream title name the stream's folder. */
export const STREAM_TITLE_CHARS = 40;

/** Text → file-system-safe name valid on Windows, at most `maxLength` characters. '' when nothing usable is left. */
function toSlug(text: string, maxLength: number): string {
  const trimDashes = (s: string) => s.replace(/^-+|-+$/g, '');
  let slug = String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\p{M}-]/gu, '')
    .replace(/-+/g, '-');
  slug = trimDashes(slug);
  slug = trimDashes([...slug].slice(0, maxLength).join(''));
  return RESERVED.test(slug) ? `clip-${slug}` : slug;
}

/** Title → file-system-safe name valid on Windows. Keeps Unicode letters and digits; empty → 'clip'. */
export function slugify(title: string): string {
  return toSlug(title, MAX_SLUG_LENGTH) || 'clip';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Local time, `2026-11-14_18-30`. */
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const safeToken = (s: string, fallback: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '') || fallback;

/** `<first 40 characters of the stream title>_<start time>`; falls back to the stream id when there is no usable title. */
export function sessionFolderName(stream: Pick<CaptureSession, 'streamId' | 'streamTitle'>, startedAt: Date): string {
  const label = toSlug(stream.streamTitle ?? '', STREAM_TITLE_CHARS) || safeToken(stream.streamId, 'unknown');
  return `${label}_${stamp(startedAt)}`;
}

export function clipFolderName(createdAt: Date, slug: string, clipId: string): string {
  const hex = clipId.toLowerCase().replace(/[^0-9a-f]/g, '');
  return `${stamp(createdAt)}_${slug}_${hex.slice(-4).padStart(4, '0')}`;
}

export function clipPaths(
  libraryDir: string,
  session: Pick<CaptureSession, 'streamer' | 'streamId' | 'streamTitle' | 'startedAt'>,
  createdAt: Date,
  title: string,
  clipId: string,
): { dir: string; mp4Path: string; markersPath: string; slug: string } {
  const slug = slugify(title);
  const dir = join(
    libraryDir,
    safeToken(session.streamer, 'unknown'),
    sessionFolderName(session, new Date(session.startedAt)),
    clipFolderName(createdAt, slug, clipId),
  );
  return { dir, mp4Path: join(dir, `${slug}.mp4`), markersPath: join(dir, 'markers.json'), slug };
}
