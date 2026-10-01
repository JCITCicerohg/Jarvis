import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { fallbackPlan } from '../src/query/planner.ts';
import { GenError, getGeneration } from '../src/gen/registry.ts';
import { GenerationManager } from '../src/gen/manager.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, m: GenerationManager;
const fake = new FakeEmbedder();
const big = new FakeEmbedder(8); big.model = 'fake-hash-8';

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-mgr-')));
  await ingestFile({ db, gen: 1, blob, embedder: fake }, SRC, { sourceId: 'hilton-pbi', driveItemId: 'P', parentId: null, name: 'Pool report.txt', folders: ['Engineering'], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('The pool pump was replaced in August.'));
  m = new GenerationManager({
    db, blob, planner: { plan: async q => fallbackPlan(q) }, sources: [SRC],
    embedderFor: model => (model === 'fake-hash-8' ? big : fake), nextEmbedder: () => fake,
    evalRows: () => [{ question: 'pool pump replaced', expected_files: ['Pool report.txt'] }], configVersion: 'v2',
  });
});
afterAll(async () => { await db.end(); });

describe('GenerationManager', () => {
  it('builds, evaluates, marks ready, cuts over and rolls back', async () => {
    expect(await m.startBuild()).toBe(2);
    await expect(m.startBuild()).rejects.toThrow(GenError);
    await m.waitForBuild();
    expect(await getGeneration(db, 2)).toMatchObject({ status: 'ready', build_done: 1, build_total: 1, eval_hit5: 1, config_version: 'v2', note: null });
    expect((await m.targets()).extra.map(t => t.gen)).toEqual([2]);
    expect(await m.cutover(2)).toEqual({ from: 1, to: 2 });
    expect((await m.queryDeps()).gen).toBe(2);
    const t = await m.targets();
    expect([t.primary.gen, ...t.extra.map(x => x.gen)]).toEqual([2, 1]);
    expect(await m.rollback()).toEqual({ from: 2, to: 1 });
  });

  it('keeps a generation catching_up with reasons when the gate fails', async () => {
    m = new GenerationManager({ ...(m as unknown as { d: ConstructorParameters<typeof GenerationManager>[0] }).d, evalRows: () => [] });
    await m.startBuild();
    await m.waitForBuild();
    expect(await getGeneration(db, 2)).toMatchObject({ status: 'catching_up', note: 'No eval questions configured (eval/questions.jsonl).' });
  });

  it('marks a generation failed when the build throws', async () => {
    m = new GenerationManager({ ...(m as unknown as { d: ConstructorParameters<typeof GenerationManager>[0] }).d, sources: null as unknown as SourceConfig[] });
    await m.startBuild();
    await m.waitForBuild();
    expect((await getGeneration(db, 2))!.status).toBe('failed');
  });

  it('queries each generation with its own embedding model', async () => {
    await db.query(`UPDATE kb_meta.generations SET embedding_model = 'fake-hash-8' WHERE id = 1`);
    expect((await m.queryDeps()).embedder).toBe(big);
  });
});
