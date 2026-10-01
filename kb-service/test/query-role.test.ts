import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.ts';
import { createGeneration } from '../src/gen/registry.ts';
import { queryUrl } from '../src/db/migrate.ts';
import { freshDb, queryDb } from './helpers.ts';

let db: Db, q: Db;
beforeAll(async () => { db = await freshDb(); await createGeneration(db, 'fake-hash', 384, null); q = queryDb(); });
afterAll(async () => { await q.end(); await db.end(); });

describe('kb_query role', () => {
  it('builds its connection URL from the main one', () => {
    expect(queryUrl('postgres://kb:kb@localhost:5433/kb_test', 's3cret')).toBe('postgres://kb_query:s3cret@localhost:5433/kb_test');
  });

  it('can read official tables in every generation, and write only corrections and the query log', async () => {
    expect((await q.query('SELECT count(*)::int n FROM kb_g1.documents')).rows[0].n).toBe(0);
    expect((await q.query('SELECT count(*)::int n FROM kb_g2.chunks')).rows[0].n).toBe(0);
    await q.query(`INSERT INTO kb_meta.corrections (text, original_message, author, scope, status) VALUES ('x', 'x', 'owner', 'global', 'pending')`);
    await q.query(`UPDATE kb_meta.corrections SET status = 'approved'`);
    await q.query(`INSERT INTO kb_meta.query_log (question) VALUES ('q')`);
  });

  it('is refused by Postgres when it tries to change official data', async () => {
    await expect(q.query(`DELETE FROM kb_g1.documents`)).rejects.toThrow(/permission denied/);
    await expect(q.query(`INSERT INTO kb_g2.documents (source_id, drive_item_id, path, name) VALUES ('s','d','p','n')`)).rejects.toThrow(/permission denied/);
    await expect(q.query(`UPDATE kb_meta.settings SET value = '2'`)).rejects.toThrow(/permission denied/);
    await expect(q.query(`DELETE FROM kb_meta.corrections`)).rejects.toThrow(/permission denied/);
  });
});
