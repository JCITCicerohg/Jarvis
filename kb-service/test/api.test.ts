import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Db } from '../src/db/pool.ts';
import { upsertSources, type SourceConfig } from '../src/config.ts';
import { GenError, type Generation } from '../src/gen/registry.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { fallbackPlan } from '../src/query/planner.ts';
import { createApp, type GenAccess } from '../src/api/server.ts';
import { freshDb, queryDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, q: Db, server: Server, base: string, synced: (string | undefined)[] = [];
const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };

beforeAll(async () => {
  db = await freshDb();
  q = queryDb();
  await upsertSources(db, [SRC]);
  const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-api-')));
  await ingestFile({ db, gen: 1, blob, embedder: new FakeEmbedder() }, SRC, { sourceId: 'hilton-pbi', driveItemId: 'T', parentId: null, name: 'Pool notes.csv', folders: ['Engineering'], webUrl: 'https://sp/T', mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('Item,Cost\nPool pump,1200\nFilter,80\n'));
  const qd = { db: q, gen: 1, blob, embedder: new FakeEmbedder(), planner: { plan: async (q: string) => fallbackPlan(q) } };
  const gen1 = { id: 1, status: 'active' } as Generation;
  const gens: GenAccess = {
    queryDeps: async () => qd,
    list: async () => [gen1],
    startBuild: async () => 2,
    evaluate: async () => ({ ready: false, reasons: ['Build is not finished (0 of 1 files).'] }),
    cutover: async id => { if (id !== 2) throw new GenError(`Generation ${id} is not ready (status active).`); return { from: 1, to: 2 }; },
    rollback: async () => { throw new GenError('Nothing to roll back to: no generation was retired in the last 7 days.'); },
    discard: async () => undefined,
  };
  const app = createApp({
    db, queryDb: q, blob, apiKeys: new Map([['secret', 'owner']]), adminKeys: new Map([['admin-secret', 'owner-admin']]),
    sources: [SRC], graph: null, syncNow: async s => { synced.push(s); }, gens,
    extractor: { name: 'fake', json: async (_s: string, user: string) => (user.includes('which place')
      ? { fact: '', clarify: 'Which hotel do you mean?', hotel: null, department: null, dataset: null, entities: [], period_from: null, period_to: null }
      : { fact: 'The pool pump costs 1,500 now.', clarify: null, hotel: 'Hilton Palm Beach PBI', department: null, dataset: 'Pool notes', entities: ['Pool pump'], period_from: null, period_to: null }) },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await db.end(); await q.end(); });

describe('API', () => {
  it('health needs no key; /v1 rejects a missing or wrong key', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/status`)).status).toBe(401);
    expect((await fetch(`${base}/v1/status`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('POST /v1/query returns Result JSON and logs the user', async () => {
    const r = await fetch(`${base}/v1/query`, { method: 'POST', headers: auth, body: JSON.stringify({ question: 'pool pump cost' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.passages[0].file).toBe('Pool notes.csv');
    expect((await db.query('SELECT user_name FROM kb_meta.query_log ORDER BY id DESC LIMIT 1')).rows[0].user_name).toBe('owner');
  });

  it('validates bodies', async () => {
    const r = await fetch(`${base}/v1/query`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/question/);
  });

  it('POST /v1/search, GET /v1/datasets and the Parquet file', async () => {
    const s = await (await fetch(`${base}/v1/search`, { method: 'POST', headers: auth, body: JSON.stringify({ query: 'filter' }) })).json();
    expect(s.passages.length).toBeGreaterThan(0);
    const ds = await (await fetch(`${base}/v1/datasets?dataset=Pool%20notes`, { headers: auth })).json();
    expect(ds.datasets).toHaveLength(1);
    expect(ds.datasets[0]).toMatchObject({ dataset: 'Pool notes', row_count: 2, columns: [{ name: 'item', type: 'text' }, { name: 'cost', type: 'number' }] });
    const f = await fetch(`${base}/v1/datasets/${ds.datasets[0].id}/file`, { headers: auth });
    expect(f.status).toBe(200);
    expect(Buffer.from(await f.arrayBuffer()).subarray(0, 4).toString()).toBe('PAR1');
    expect((await fetch(`${base}/v1/datasets/999999/file`, { headers: auth })).status).toBe(404);
  });

  it('GET /v1/status and POST /v1/sync', async () => {
    const st = await (await fetch(`${base}/v1/status`, { headers: auth })).json();
    expect(st.generation).toBe(1);
    expect(st.generations).toEqual([{ id: 1, status: 'active' }]);
    expect(st.sources[0]).toMatchObject({ id: 'hilton-pbi', documents: { indexed: 1 } });
    const r = await fetch(`${base}/v1/sync`, { method: 'POST', headers: auth, body: JSON.stringify({ source: 'hilton-pbi' }) });
    expect(r.status).toBe(202);
    expect(synced).toEqual(['hilton-pbi']);
  });

  it('admin routes need an admin key and map rule refusals to 409', async () => {
    const admin = { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/v1/admin/generations`, { headers: auth })).status).toBe(401);
    expect(await (await fetch(`${base}/v1/admin/generations`, { headers: admin })).json()).toEqual({ generations: [{ id: 1, status: 'active' }] });
    const b = await fetch(`${base}/v1/admin/generations`, { method: 'POST', headers: admin });
    expect([b.status, await b.json()]).toEqual([202, { id: 2 }]);
    expect(await (await fetch(`${base}/v1/admin/generations/2/evaluate`, { method: 'POST', headers: admin })).json()).toEqual({ ready: false, reasons: ['Build is not finished (0 of 1 files).'] });
    const bad = await fetch(`${base}/v1/admin/cutover`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: 1 }) });
    expect([bad.status, (await bad.json()).error]).toEqual([409, 'Generation 1 is not ready (status active).']);
    const ok = await fetch(`${base}/v1/admin/cutover`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: 2 }) });
    expect(await ok.json()).toEqual({ from: 1, to: 2 });
    expect((await fetch(`${base}/v1/admin/rollback`, { method: 'POST', headers: admin })).status).toBe(409);
    expect((await fetch(`${base}/v1/admin/cutover`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: 'x' }) })).status).toBe(400);
  });

  it('admin keys can also use the query API', async () => {
    expect((await fetch(`${base}/v1/status`, { headers: { Authorization: 'Bearer admin-secret' } })).status).toBe(200);
  });

  it('records corrections (global by default), asks when unclear, and lets an admin approve', async () => {
    const c = await fetch(`${base}/v1/corrections`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'actually the pool pump costs 1500 now' }) });
    expect(c.status).toBe(201);
    const body = await c.json();
    expect(body.correction).toMatchObject({ text: 'The pool pump costs 1,500 now.', author: 'owner', scope: 'global', status: 'pending', dataset: 'Pool notes' });
    expect(body.correction).not.toHaveProperty('embedding');
    const unclear = await (await fetch(`${base}/v1/corrections`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'which place slipped' }) })).json();
    expect(unclear).toEqual({ clarify: 'Which hotel do you mean?' });
    const deny = await fetch(`${base}/v1/corrections/${body.correction.id}/decide`, { method: 'POST', headers: auth, body: JSON.stringify({ decision: 'approve' }) });
    expect(deny.status).toBe(403);
    const ok = await fetch(`${base}/v1/corrections/${body.correction.id}/decide`, { method: 'POST', headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    expect((await ok.json()).correction.status).toBe('approved');
    const list = await (await fetch(`${base}/v1/corrections?status=approved`, { headers: auth })).json();
    expect(list.corrections.map((x: { text: string }) => x.text)).toEqual(['The pool pump costs 1,500 now.']);
    expect((await fetch(`${base}/v1/corrections`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'x', scope: 'team' }) })).status).toBe(400);
  });
});
