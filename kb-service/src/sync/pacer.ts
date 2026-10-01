import type { Db } from '../db/pool.ts';

export interface Pacer { beforeFile(): Promise<void> }

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** p95 latency (ms) of real queries in the last 5 minutes; eval runs are excluded. */
export async function queryP95(db: Db): Promise<number> {
  const r = await db.query(
    `SELECT coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) AS p
     FROM kb_meta.query_log WHERE at > now() - interval '5 minutes' AND user_name IS DISTINCT FROM 'eval' AND latency_ms IS NOT NULL`);
  return Number(r.rows[0].p);
}

/** Slow lane: at most `perMinute` files, and none while users' queries are slow. */
export class LatencyPacer implements Pacer {
  private last = Number.NEGATIVE_INFINITY;
  constructor(
    private db: Db,
    private opts = { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 },
    private sleep: (ms: number) => Promise<void> = defaultSleep,
    private now: () => number = Date.now,
  ) {}

  async beforeFile(): Promise<void> {
    while ((await queryP95(this.db)) > this.opts.p95LimitMs) await this.sleep(this.opts.pauseMs);
    const wait = this.last + 60_000 / this.opts.perMinute - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }
}
