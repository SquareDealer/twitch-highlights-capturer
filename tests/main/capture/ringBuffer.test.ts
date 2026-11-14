import type { Segment } from '@shared/types';
import { RingBufferManager } from '../../../src/main/capture/ringBuffer';

let now = 0;
let unlinked: string[] = [];
let failUnlink = false;
let removedRows: string[] = [];
let ring: RingBufferManager;

function make(maxPinnedBytes = 1_000_000) {
  return new RingBufferManager({
    segments: { insert: () => {}, remove: (_s, e, q) => void removedRows.push(`${e}/${q}`), clear: () => {} },
    retentionMs: 300_000,
    maxPinnedBytes,
    now: () => now,
    unlink: async (p) => {
      if (failUnlink) throw new Error('EBUSY');
      unlinked.push(p);
    },
  });
}

/** 2-second segment `seq` of `epoch`, completed at wall time 1_000_000 + endMs. */
const seg = (epoch: number, seq: number, bytes = 100): Segment => ({
  sessionId: 's', epoch, seq, path: `/b/e${epoch}/seg_${seq}.ts`, startMs: seq * 2000, endMs: seq * 2000 + 2000, bytes, completedAtWallMs: 1_000_000 + seq * 2000 + 2000,
});

beforeEach(() => {
  now = 1_000_000;
  unlinked = [];
  removedRows = [];
  failUnlink = false;
  ring = make();
});

test('cleanup удаляет незакреплённые сегменты старше 300 с и оставляет свежие', async () => {
  for (let i = 0; i < 200; i++) ring.add(seg(0, i)); // 400 s of video
  now = 1_000_000 + 400_000;
  await ring.cleanup();
  // segments completed before now-300s: completedAt < 1_100_000 → endMs < 100_000 → seq 0..48
  expect(unlinked).toHaveLength(49);
  expect(ring.select(0, 0, 400_000)[0]!.seq).toBe(49);
  expect(removedRows).toContain('0/0');
  expect(ring.bufferedMs()).toBe(151 * 2000);
});

test('сегмент, пересекающий pin [t−30с, t+60с], не удаляется, даже если ему 20 минут', async () => {
  for (let i = 0; i < 100; i++) ring.add(seg(0, i));
  ring.pin('marker-1', 0, 50_000 - 30_000, 50_000 + 60_000);
  now += 20 * 60_000;
  await ring.cleanup();
  const left = ring.select(0, 0, 1e9);
    expect(left.map((s) => s.seq)).toEqual(Array.from({ length: 45 }, (_, i) => i + 10)); // seq 10..54: a segment that only touches the range is not part of it
});

test('после unpin тот же сегмент удаляется следующим cleanup', async () => {
  ring.add(seg(0, 5));
  ring.pin('m', 0, 0, 60_000);
  now += 20 * 60_000;
  await ring.cleanup();
  expect(unlinked).toEqual([]);
  ring.unpin('m');
  await ring.cleanup();
  expect(unlinked).toEqual(['/b/e0/seg_5.ts']);
});

test('сегмент, закреплённый двумя владельцами, живёт, пока не сняты оба', async () => {
  ring.add(seg(0, 5));
  ring.pin('a', 0, 0, 60_000);
  ring.pin('b', 0, 10_000, 20_000);
  now += 20 * 60_000;
  ring.unpin('a');
  await ring.cleanup();
  expect(unlinked).toEqual([]);
  ring.unpin('b');
  await ring.cleanup();
  expect(unlinked).toHaveLength(1);
});

test('повторный pin того же владельца заменяет диапазон', async () => {
  ring.add(seg(0, 5));
  ring.pin('a', 0, 0, 60_000);
  ring.pin('a', 0, 100_000, 160_000);
  now += 20 * 60_000;
  await ring.cleanup();
  expect(unlinked).toHaveLength(1);
});

test('pin относится только к своей эпохе', async () => {
  ring.add(seg(0, 5));
  ring.add(seg(1, 5));
  ring.pin('m', 1, 0, 60_000);
  now += 20 * 60_000;
  await ring.cleanup();
  expect(unlinked).toEqual(['/b/e0/seg_5.ts']);
});

test('select возвращает сегменты, частично пересекающие диапазон, в порядке seq', () => {
  for (const i of [3, 1, 2, 0, 4]) ring.add(seg(0, i));
  expect(ring.select(0, 3_000, 7_000).map((s) => s.seq)).toEqual([1, 2, 3]);
  expect(ring.select(1, 0, 10_000)).toEqual([]);
  expect(ring.latest(0)!.seq).toBe(4);
  expect(ring.latest(7)).toBeNull();
});

test('pinLimit испускается один раз при превышении maxPinnedBytes и ничего не удаляет', async () => {
  ring = make(250);
  const events: unknown[] = [];
  ring.on('pinLimit', (e) => events.push(e));
  for (let i = 0; i < 5; i++) ring.add(seg(0, i, 100));
  ring.pin('m', 0, 0, 5_000); // 3 segments = 300 bytes
  expect(ring.pinnedBytes()).toBe(300);
  expect(events).toEqual([{ pinnedBytes: 300, maxPinnedBytes: 250 }]);
  ring.pin('m2', 0, 0, 10_000);
  expect(events).toHaveLength(1);
  now += 20 * 60_000;
  await ring.cleanup();
  expect(unlinked).toEqual([]);
  ring.unpin('m');
  ring.unpin('m2');
  ring.add(seg(0, 5, 100));
  ring.add(seg(0, 6, 100));
  ring.add(seg(0, 7, 100));
  ring.pin('m3', 0, 10_000, 16_000);
  expect(events).toHaveLength(2);
});

test('ошибка unlink (файл занят) не роняет cleanup, сегмент остаётся в индексе до следующей попытки', async () => {
  ring.add(seg(0, 0));
  now += 20 * 60_000;
  failUnlink = true;
  await expect(ring.cleanup()).resolves.toBeUndefined();
  expect(ring.select(0, 0, 10_000)).toHaveLength(1);
  failUnlink = false;
  await ring.cleanup();
  expect(ring.select(0, 0, 10_000)).toHaveLength(0);
});

test('add испускает segment; clearAll удаляет всё, включая закреплённое', async () => {
  const got: number[] = [];
  ring.on('segment', (s: Segment) => got.push(s.seq));
  ring.add(seg(0, 0));
  ring.add(seg(1, 0));
  ring.pin('m', 0, 0, 5000);
  await ring.clearAll();
  expect(got).toEqual([0, 0]);
  expect(unlinked).toHaveLength(2);
  expect(ring.latest(1)).toBeNull();
  expect(ring.pinnedBytes()).toBe(0);
});
