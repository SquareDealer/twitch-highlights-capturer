import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegSegmentArgs, normalizeChannel, parseProbeOutput, streamlinkArgs } from '../../../src/main/capture/processes';
import { parseSegmentLine } from '../../../src/main/capture/segmentList';
import { hasFfmpeg, synthVideo, tmpDir } from '../../helpers';

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
  const args = ffmpegSegmentArgs(join('buf', 'e0'), 2, false);
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
  expect(parseProbeOutput('{"metadata":{"id":"987654321","author":"x"},"streams":{}}')).toEqual({ live: true, streamId: '987654321', qualities: ['best'] });
  expect(parseProbeOutput('{"streams":{}}')).toEqual({ live: true, streamId: 'unknown', qualities: ['best'] });
  expect(parseProbeOutput('{"error":"No playable streams found on this URL"}')).toEqual({ live: false, reason: 'No playable streams found on this URL' });
  expect(parseProbeOutput('not json')).toMatchObject({ live: false });
  expect(parseProbeOutput('{"metadata":{"id":12345}}')).toEqual({ live: true, streamId: '12345', qualities: ['best'] });
});

test('ffmpegSegmentArgs: при pcm добавляет 16 кГц моно PCM на stdout, выровненный по меткам времени', () => {
  const a = ffmpegSegmentArgs('D:/b/e0', 2, true);
  // aresample только для PCM-выхода (после его -map): дыры в метках заполняются тишиной, t=0 как у сегментов
  expect(a.slice(-11)).toEqual([
    '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
  ]);
  expect(a.indexOf('-af')).toBeGreaterThan(a.findIndex((x) => x.endsWith('seg_%06d.ts'))); // not applied to the segments
});

test('ffmpegSegmentArgs: без pcm список аргументов прежний', () => {
  expect(ffmpegSegmentArgs('D:/b/e0', 2, false)).not.toContain('pipe:1');
});

test('parseProbeOutput: имена качеств из streamlink --json', () => {
  const r = parseProbeOutput(JSON.stringify({ metadata: { id: 42 }, streams: { '720p60': {}, best: {}, worst: {}, audio_only: {} } }));
  expect(r).toEqual({ live: true, streamId: '42', qualities: ['best', '720p60', 'worst', 'audio_only'] });
});

describe.skipIf(!hasFfmpeg)('ffmpeg', () => {
  test('PCM-часы идут по меткам времени через короткую дыру в потоке', async () => {
    const dir = tmpDir();
    // два куска по 4 с, второй сдвинут на 7 с: в потоке дыра 3 с, как после короткого обрыва HLS
    for (const [name, offset] of [['a', '0'], ['b', '7']] as const) {
      synthVideo(4, ['-output_ts_offset', offset, '-f', 'mpegts', join(dir, `${name}.ts`)]);
    }
    const stream = Buffer.concat([readFileSync(join(dir, 'a.ts')), readFileSync(join(dir, 'b.ts'))]);
    const segDir = join(dir, 'e0');
    mkdirSync(segDir);
    const ff = spawn('ffmpeg', ffmpegSegmentArgs(segDir, 2, true));
    const pcm: Buffer[] = [];
    ff.stdout.on('data', (d: Buffer) => pcm.push(d));
    ff.stdin.end(stream);
    expect(await new Promise((resolve) => ff.on('close', resolve))).toBe(0);
    const pcmMs = Buffer.concat(pcm).length / 32;
    const entries = readFileSync(join(segDir, 'segments.csv'), 'utf8').trim().split('\n').map(parseSegmentLine);
    const videoMs = (entries.at(-1)!.endSec - entries[0]!.startSec) * 1000;
    expect(videoMs).toBeGreaterThan(10_500); // 11 с с учётом дыры
    expect(Math.abs(pcmMs - videoMs)).toBeLessThan(200); // без aresample PCM отстаёт почти на всю дыру (~2,9 с)
  });

  test('реальный ffmpeg с ffmpegSegmentArgs режет mpegts из pipe на сегменты и пишет разбираемый csv', async () => {
    const dir = tmpDir();
    const source = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=6:r=30:s=320x240', '-f', 'lavfi', '-i', 'sine=d=6',
      '-g', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1',
    ]);
    const segmenter = spawn('ffmpeg', ffmpegSegmentArgs(dir, 2, false));
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
