import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';

export type ConcatFn = (segments: string[], outFile: string) => Promise<void>;

/** Joins MPEG-TS segments into one MP4 without re-encoding. */
export function concatSegments(ffmpegPath: string): ConcatFn {
  return async (segments, outFile) => {
    const listFile = `${outFile}.txt`;
    // concat demuxer syntax: single-quoted path, a literal quote is written as '\''
    const list = segments.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listFile, `${list}\n`, 'utf8');
    try {
      await new Promise<void>((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', outFile];
        execFile(ffmpegPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) =>
          err ? reject(new Error(String(stderr).trim().split('\n').pop() || err.message)) : resolve(),
        );
      });
    } finally {
      await rm(listFile, { force: true });
    }
  };
}
