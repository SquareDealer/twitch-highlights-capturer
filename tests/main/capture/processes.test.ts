import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegSegmentArgs, normalizeChannel, parseProbeOutput, streamlinkArgs } from '../../../src/main/capture/processes';
import { parseSegmentLine } from '../../../src/main/capture/segmentList';
import { hasFfmpeg, tmpDir } from '../../helpers';

test.each([
  ['Foo_Bar', 'foo_bar'],
  ['https://www.twitch.tv/Foo_Bar/', 'foo_bar'],
  ['twitch.tv/x?tt=1', 'x'],
  ['  shroud ', 'shroud'],
  ['http://m.twitch.tv/abc', 'abc'],
])('normalizeChannel(%j) = %j', (input, expected) => expect(normalizeChannel(input)).toBe(expected));

test.each(['', 'a b', 'foo/bar/baz', 'имя', 'x'.repeat(26), '--help', 'https://evil.com/foo'])('normalizeChannel(%j) = null', (input) =>
  expect(normalizeChannel(input)).toBeNull(),
);

test('streamlinkArgs: stdout, low latency, канал и качество', () => {
  expect(streamlinkArgs('foo', 'best')).toEqual(['--stdout', '--twitch-low-latency', '--retry-streams', '0', 'https://twitch.tv/foo', 'best']);
});

test('ffmpegSegmentArgs: -c copy, segment_time 2, csv-список в каталоге эпохи', () => {
  const args = ffmpegSegmentArgs(join('buf', 'e0'), 2);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  expect(after('-c')).toBe('copy');
  expect(after('-segment_time')).toBe('2');
  expect(after('-segment_list')).toBe(join('buf', 'e0', 'segments.csv'));
  expect(after('-segment_list_type')).toBe('csv');
  expect(after('-reset_timestamps')).toBe('0');
  expect(after('-i')).toBe('pipe:0');
  expect(args.at(-1)).toBe(join('buf', 'e0', 'seg_%06d.ts'));
});

test('parseProbeOutput: эфир, оффлайн, мусор', () => {
  expect(parseProbeOutput('{"metadata":{"id":"987654321","author":"x","title":"  Ranked до Immortal!  "},"streams":{}}')).toEqual({ live: true, streamId: '987654321', streamTitle: 'Ranked до Immortal!' });
  expect(parseProbeOutput('{"metadata":{"id":"987654321","author":"x"},"streams":{}}')).toEqual({ live: true, streamId: '987654321', streamTitle: '' });
  expect(parseProbeOutput('{"metadata":{"id":"1","title":null}}')).toEqual({ live: true, streamId: '1', streamTitle: '' });
  expect(parseProbeOutput('{"streams":{}}')).toEqual({ live: true, streamId: 'unknown', streamTitle: '' });
  expect(parseProbeOutput('{"error":"No playable streams found on this URL"}')).toEqual({ live: false, reason: 'No playable streams found on this URL' });
  expect(parseProbeOutput('not json')).toMatchObject({ live: false });
  expect(parseProbeOutput('{"metadata":{"id":12345}}')).toEqual({ live: true, streamId: '12345', streamTitle: '' });
});

describe.skipIf(!hasFfmpeg)('ffmpeg', () => {
  test('реальный ffmpeg с ffmpegSegmentArgs режет mpegts из pipe на сегменты и пишет разбираемый csv', async () => {
    const dir = tmpDir();
    const source = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=6:r=30:s=320x240', '-f', 'lavfi', '-i', 'sine=d=6',
      '-g', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1',
    ]);
    const segmenter = spawn('ffmpeg', ffmpegSegmentArgs(dir, 2));
    source.stdout.pipe(segmenter.stdin);
    const code = await new Promise((resolve) => segmenter.on('exit', resolve));
    expect(code).toBe(0);
    const files = readdirSync(dir).filter((f) => /^seg_\d{6}\.ts$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const entries = readFileSync(join(dir, 'segments.csv'), 'utf8').trim().split('\n').map(parseSegmentLine);
    expect(entries.every((e) => e !== null)).toBe(true);
    expect(entries).toHaveLength(files.length);
    const first = entries[0]!;
    const last = entries.at(-1)!;
    expect(last.endSec - first.startSec).toBeGreaterThan(5);
    expect(last.endSec - first.startSec).toBeLessThan(7);
  });
});
