import type { Db } from '../../../src/main/db';
import { openDb } from '../../../src/main/db';
import { JobQueue } from '../../../src/main/jobs/jobQueue';

let db: Db;
let now: number;
beforeEach(() => {
  db = openDb(':memory:');
  now = 1000;
});
const rows = () => db.prepare('SELECT status, attempts, last_error FROM jobs ORDER BY rowid').all() as Array<{ status: string; attempts: number; last_error: string | null }>;

test('задачи выполняются по одной в порядке постановки', async () => {
  const seen: number[] = [];
  const q = new JobQueue<{ n: number }>(db, 'export', async (p) => void seen.push(p.n), { maxAttempts: 1, backoffMs: () => 0, now: () => now });
  q.enqueue({ n: 1 });
  q.enqueue({ n: 2 });
  expect(await q.tick()).toBe(true);
  expect(seen).toEqual([1]);
  expect(await q.tick()).toBe(true);
  expect(await q.tick()).toBe(false);
  expect(seen).toEqual([1, 2]);
  expect(rows().map((r) => r.status)).toEqual(['done', 'done']);
});

test('ошибка → повтор не раньше backoffMs(attempt); после maxAttempts → failed и onFailed с текстом ошибки', async () => {
  const failed: Array<[unknown, string]> = [];
  let calls = 0;
  const q = new JobQueue<{ clipId: string }>(
    db, 'sync',
    async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    },
    { maxAttempts: 3, backoffMs: (n) => 30_000 * 2 ** (n - 1), onFailed: (p, e) => failed.push([p, e]), now: () => now },
  );
  q.enqueue({ clipId: 'c1' });
  expect(await q.tick()).toBe(true);
  expect(rows()[0]).toMatchObject({ status: 'queued', attempts: 1, last_error: 'boom 1' });
  now += 29_999;
  expect(await q.tick()).toBe(false);
  now += 1;
  expect(await q.tick()).toBe(true); // attempt 2, next after 60 s
  now += 59_999;
  expect(await q.tick()).toBe(false);
  now += 1;
  expect(await q.tick()).toBe(true);
  expect(rows()[0]).toMatchObject({ status: 'failed', attempts: 3, last_error: 'boom 3' });
  expect(failed).toEqual([[{ clipId: 'c1' }, 'boom 3']]);
  expect(await q.tick()).toBe(false);
});

test('recover возвращает running в queued (выход приложения посреди задачи)', async () => {
  let release!: () => void;
  let runs = 0;
  const q = new JobQueue<object>(db, 'sync', () => new Promise<void>((r) => (runs++, (release = r))), { maxAttempts: 5, backoffMs: () => 0, now: () => now });
  q.enqueue({});
  const running = q.tick();
  await Promise.resolve();
  expect(rows()[0]!.status).toBe('running');
  // simulated restart: a new queue over the same database
  const q2 = new JobQueue<object>(db, 'sync', async () => void runs++, { maxAttempts: 5, backoffMs: () => 0, now: () => now });
  expect(await q2.tick()).toBe(false);
  q2.recover();
  expect(await q2.tick()).toBe(true);
  expect(runs).toBe(2);
  release();
  await running;
});

test('dedupeKey не даёт поставить вторую такую же задачу, пока первая queued/running', async () => {
  const q = new JobQueue<{ clipId: string }>(db, 'sync', async () => {}, { maxAttempts: 1, backoffMs: () => 0, now: () => now });
  const a = q.enqueue({ clipId: 'c1' }, 'c1');
  expect(q.enqueue({ clipId: 'c1' }, 'c1')).toBe(a);
  expect(q.enqueue({ clipId: 'c2' }, 'c2')).not.toBe(a);
  expect(rows()).toHaveLength(2);
  await q.tick();
  expect(q.enqueue({ clipId: 'c1' }, 'c1')).not.toBe(a); // the first one is done
});

test('enqueue с dedupeKey делает отложенную после ошибки задачу готовой немедленно', async () => {
  let fail = true;
  const q = new JobQueue<object>(db, 'sync', async () => {
    if (fail) throw new Error('offline');
  }, { maxAttempts: 5, backoffMs: () => 60_000, now: () => now });
  const id = q.enqueue({}, 'c1');
  await q.tick();
  fail = false;
  expect(await q.tick()).toBe(false);
  expect(q.enqueue({}, 'c1')).toBe(id); // manual "sync now"
  expect(await q.tick()).toBe(true);
  expect(rows()[0]!.status).toBe('done');
});

test('retryFailed возвращает failed-задачи в очередь с attempts = 0', async () => {
  let fail = true;
  const q = new JobQueue<object>(db, 'sync', async () => {
    if (fail) throw new Error('x');
  }, { maxAttempts: 1, backoffMs: () => 0, now: () => now });
  q.enqueue({});
  await q.tick();
  expect(rows()[0]!.status).toBe('failed');
  fail = false;
  expect(q.retryFailed()).toBe(1);
  expect(rows()[0]).toMatchObject({ status: 'queued', attempts: 0 });
  expect(await q.tick()).toBe(true);
  expect(rows()[0]!.status).toBe('done');
});

test('очереди разных type не видят задачи друг друга', async () => {
  const seen: string[] = [];
  const a = new JobQueue<object>(db, 'export', async () => void seen.push('export'), { maxAttempts: 1, backoffMs: () => 0, now: () => now });
  const b = new JobQueue<object>(db, 'sync', async () => void seen.push('sync'), { maxAttempts: 1, backoffMs: () => 0, now: () => now });
  a.enqueue({});
  expect(await b.tick()).toBe(false);
  b.recover();
  expect(b.retryFailed()).toBe(0);
  expect(await a.tick()).toBe(true);
  expect(seen).toEqual(['export']);
});

test('start запускает цикл, stop дожидается выполняемой задачи', async () => {
  let finished = false;
  const q = new JobQueue<object>(db, 'export', async () => {
    await new Promise((r) => setTimeout(r, 300));
    finished = true;
  }, { maxAttempts: 1, backoffMs: () => 0 });
  q.enqueue({});
  q.start(5);
  await vi.waitFor(() => expect(rows()[0]!.status).toBe('running'), { interval: 5 });
  await q.stop();
  expect(finished).toBe(true);
  expect(rows()[0]!.status).toBe('done');
});

test('исключение в onFailed не ломает очередь', async () => {
  const q = new JobQueue<object>(db, 'export', async () => {
    throw new Error('x');
  }, { maxAttempts: 1, backoffMs: () => 0, onFailed: () => { throw new Error('handler bug'); }, now: () => now });
  q.enqueue({});
  await expect(q.tick()).resolves.toBe(true);
  expect(rows()[0]!.status).toBe('failed');
});
