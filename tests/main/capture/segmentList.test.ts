import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSegmentLine, SegmentListTailer } from '../../../src/main/capture/segmentList';
import { tmpDir } from '../../helpers';

test('разбирает строку csv', () =>
  expect(parseSegmentLine('seg_000012.ts,24.033000,26.066000')).toEqual({ file: 'seg_000012.ts', startSec: 24.033, endSec: 26.066 }));

test.each(['', 'seg_1.ts,1.0', 'seg_1.ts,a,b', 'seg_1.ts,2.0,1.0', ',1.0,2.0'])('отклоняет %j', (l) => expect(parseSegmentLine(l)).toBeNull());

test('разбирает строку с \\r на конце', () => expect(parseSegmentLine('seg_1.ts,0.000000,2.000000\r')!.endSec).toBe(2));

test('tailer отдаёт только завершённые строки и не повторяет уже прочитанные', () => {
  const csv = join(tmpDir(), 'segments.csv');
  const seen: string[] = [];
  const tailer = new SegmentListTailer(csv, (e) => seen.push(e.file));
  tailer.poll(); // file does not exist yet
  expect(seen).toEqual([]);
  writeFileSync(csv, 'seg_000000.ts,0.000000,2.0');
  tailer.poll();
  expect(seen).toEqual([]);
  appendFileSync(csv, '00000\nseg_000001.ts,2.000000,4.000000\nseg_0000');
  tailer.poll();
  expect(seen).toEqual(['seg_000000.ts', 'seg_000001.ts']);
  tailer.poll();
  expect(seen).toEqual(['seg_000000.ts', 'seg_000001.ts']);
  appendFileSync(csv, '02.ts,4.000000,6.000000\n');
  tailer.poll();
  expect(seen).toEqual(['seg_000000.ts', 'seg_000001.ts', 'seg_000002.ts']);
});
