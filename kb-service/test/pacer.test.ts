import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.ts';
import { LatencyPacer, queryP95 } from '../src/sync/pacer.ts';
import { freshDb } from './helpers.ts';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe('LatencyPacer', () => {
  it('spaces files at 20 per minute', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const p = new LatencyPacer(db, { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 }, async ms => { sleeps.push(ms); t += ms; }, () => t);
    await p.beforeFile();
    await p.beforeFile();
    t += 1000;
    await p.beforeFile();
    expect(sleeps).toEqual([3000, 2000]);
  });

  it('pauses while query p95 latency is over the limit, ignoring eval queries', async () => {
    await db.query(`INSERT INTO kb_meta.query_log (user_name, question, latency_ms) VALUES ('owner', 'slow', 5000), ('eval', 'e', 99999)`);
    expect(await queryP95(db)).toBe(5000);
    const sleeps: number[] = [];
    const p = new LatencyPacer(db, { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 }, async ms => {
      sleeps.push(ms);
      await db.query(`DELETE FROM kb_meta.query_log WHERE user_name = 'owner'`);
    }, () => 0);
    await p.beforeFile();
    expect(sleeps).toEqual([30_000]);
  });
});
