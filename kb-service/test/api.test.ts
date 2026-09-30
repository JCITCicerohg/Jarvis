import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Db } from '../src/db/pool.ts';
import { upsertSources, type SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { fallbackPlan } from '../src/query/planner.ts';
import { createApp } from '../src/api/server.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, server: Server, base: string, synced: (string | undefined)[] = [];
const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };

beforeAll(async () => {
  db = await freshDb();
  await upsertSources(db, [SRC]);
  const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-api-')));
  await ingestFile({ db, gen: 1, blob, embedder: new FakeEmbedder() }, SRC, { sourceId: 'hilton-pbi', driveItemId: 'T', parentId: null, name: 'Pool notes.csv', folders: ['Engineering'], webUrl: 'https://sp/T', mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('Item,Cost\nPool pump,1200\nFilter,80\n'));
  const app = createApp({
    db, gen: 1, blob, embedder: new FakeEmbedder(), planner: { plan: async q => fallbackPlan(q) },
    apiKeys: new Map([['secret', 'owner']]), sources: [SRC], graph: null, syncNow: async s => { synced.push(s); },
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await db.end(); });

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
    expect(st.sources[0]).toMatchObject({ id: 'hilton-pbi', documents: { indexed: 1 } });
    const r = await fetch(`${base}/v1/sync`, { method: 'POST', headers: auth, body: JSON.stringify({ source: 'hilton-pbi' }) });
    expect(r.status).toBe(202);
    expect(synced).toEqual(['hilton-pbi']);
  });
});
