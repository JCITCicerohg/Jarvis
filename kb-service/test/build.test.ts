import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile, type ItemInfo } from '../src/ingest/pipeline.ts';
import { createGeneration } from '../src/gen/registry.ts';
import { buildGeneration } from '../src/gen/build.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
const item = (id: string, name: string, ctag = 'c1'): ItemInfo => ({ sourceId: 'hilton-pbi', driveItemId: id, parentId: null, name, folders: ['Guest Scores'], webUrl: `https://sp/${id}`, mime: null, size: 1, ctag, etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' });
let db: Db, blob: LocalBlobStore;
const g = (gen: number) => ({ db, gen, blob, embedder: new FakeEmbedder() });
const names = async (gen: number) => (await db.query(`SELECT name FROM kb_g${gen}.documents ORDER BY name`)).rows.map(r => r.name);

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-build-')));
  await db.query(`INSERT INTO kb_g1.folders (source_id, drive_item_id, parent_id, name, path) VALUES ('hilton-pbi', 'F1', NULL, 'Guest Scores', 'Guest Scores')`);
  await ingestFile(g(1), SRC, item('A', 'a.txt'), Buffer.from('Pool feedback was great.'));
  await ingestFile(g(1), SRC, item('B', 'b.txt'), Buffer.from('Breakfast scores improved.'));
  await createGeneration(db, 'fake-hash', 384, null);
});
afterAll(async () => { await db.end(); });

describe('buildGeneration', () => {
  it('rebuilds every document and folder from the raw archive, reporting progress', async () => {
    const progress: number[][] = [];
    const r = await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2), onProgress: (d, t) => { progress.push([d, t]); } });
    expect(r).toEqual({ total: 2, done: 2, skipped: 0, errors: 0 });
    expect(await names(2)).toEqual(['a.txt', 'b.txt']);
    expect((await db.query('SELECT count(*)::int n FROM kb_g2.chunks')).rows[0].n).toBeGreaterThan(0);
    expect((await db.query('SELECT count(*)::int n FROM kb_g2.folders')).rows[0].n).toBe(1);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it('never overwrites a newer version that fan-out already wrote', async () => {
    await ingestFile(g(2), SRC, item('A', 'a.txt', 'c2'), Buffer.from('NEWER pool feedback.'));
    const r = await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2) });
    expect(r.skipped).toBe(1);
    const text = (await db.query(`SELECT string_agg(c.text, ' ') t FROM kb_g2.chunks c JOIN kb_g2.documents d ON d.id = c.document_id WHERE d.drive_item_id = 'A'`)).rows[0].t;
    expect(text).toContain('NEWER');
  });

  it('counts a missing original as an error and skips sources no longer configured', async () => {
    await blob.remove('raw/hilton-pbi/b/c1');
    const r = await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2) });
    expect(r).toMatchObject({ done: 2, errors: 1 });
    const none = await buildGeneration({ db, sources: [], from: g(1), to: g(2) });
    expect(none).toMatchObject({ total: 2, skipped: 2 });
  });

  it('paces each rebuilt file', async () => {
    let paced = 0;
    await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2), pacer: { beforeFile: async () => { paced++; } } });
    expect(paced).toBe(2);
  });
});
