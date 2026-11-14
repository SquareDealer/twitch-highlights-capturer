import { randomUUID } from 'node:crypto';
import type { Db } from '../db';

export type JobType = 'export' | 'sync';

export interface JobQueueOptions<P> {
  maxAttempts: number;
  /** Delay before the next try, given the number of attempts made so far (1-based). */
  backoffMs: (attempt: number) => number;
  onFailed?: (payload: P, error: string) => void;
  now?: () => number;
}

interface JobRow {
  id: string;
  payload: string;
  attempts: number;
}

/** Persistent, sequential job queue over the `jobs` table. One instance per job type. */
export class JobQueue<P> {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<boolean> | null = null;

  constructor(
    private readonly db: Db,
    private readonly type: JobType,
    private readonly handler: (payload: P) => Promise<void>,
    private readonly opts: JobQueueOptions<P>,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** With a dedupeKey, an already queued/running job is reused (and made due immediately) instead of adding another. */
  enqueue(payload: P, dedupeKey?: string): string {
    if (dedupeKey !== undefined) {
      const existing = this.db
        .prepare("SELECT id FROM jobs WHERE type = ? AND dedupe_key = ? AND status IN ('queued', 'running') LIMIT 1")
        .get(this.type, dedupeKey) as { id: string } | undefined;
      if (existing) {
        this.db.prepare("UPDATE jobs SET next_run_at = 0 WHERE id = ? AND status = 'queued'").run(existing.id);
        return existing.id;
      }
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO jobs (id, type, payload, status, attempts, next_run_at, dedupe_key, created_at) VALUES (?, ?, ?, 'queued', 0, 0, ?, ?)")
      .run(id, this.type, JSON.stringify(payload), dedupeKey ?? null, this.now());
    return id;
  }

  /** Call once at startup: jobs interrupted by a shutdown go back to the queue. */
  recover(): void {
    this.db.prepare("UPDATE jobs SET status = 'queued', next_run_at = 0 WHERE type = ? AND status = 'running'").run(this.type);
  }

  /** Runs one due job. Returns false when nothing is due (or a job is already running in this instance). */
  tick(): Promise<boolean> {
    if (this.current) return Promise.resolve(false);
    const job = this.db
      .prepare("SELECT id, payload, attempts FROM jobs WHERE type = ? AND status = 'queued' AND next_run_at <= ? ORDER BY rowid LIMIT 1")
      .get(this.type, this.now()) as JobRow | undefined;
    if (!job) return Promise.resolve(false);
    this.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    this.current = this.run(job).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  /** Stops polling and waits for the job in flight. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.current?.catch(() => undefined);
  }

  retryFailed(): number {
    return this.db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, next_run_at = 0 WHERE type = ? AND status = 'failed'").run(this.type).changes;
  }

  private async run(job: JobRow): Promise<boolean> {
    const payload = JSON.parse(job.payload) as P;
    try {
      await this.handler(payload);
      this.db.prepare("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?").run(job.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const attempts = job.attempts + 1;
      if (attempts >= this.opts.maxAttempts) {
        this.db.prepare("UPDATE jobs SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, message, job.id);
        try {
          this.opts.onFailed?.(payload, message);
        } catch {
          /* a failing callback must not stall the queue */
        }
      } else {
        this.db
          .prepare("UPDATE jobs SET status = 'queued', attempts = ?, last_error = ?, next_run_at = ? WHERE id = ?")
          .run(attempts, message, this.now() + this.opts.backoffMs(attempts), job.id);
      }
    }
    return true;
  }
}
