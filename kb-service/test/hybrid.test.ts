import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { hybridSearch, rrf } from '../src/search/hybrid.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db;
const d = () => ({ db, gen: 1, embedder: new FakeEmbedder() });
const none = { must: [], should: [], not: [] };

beforeAll(async () => {
  db = await freshDb();
  const deps = { db, gen: 1, blob: new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-hy-'))), embedder: new FakeEmbedder() };
  const add = (id: string, folders: string[], name: string, text: string) => ingestFile(deps, SRC, {
    sourceId: 'hilton-pbi', driveItemId: id, parentId: null, name, folders, webUrl: `https://sp/${id}`, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z',
  }, Buffer.from(text));
  await add('SE8', ['Guest Scores', 'Stay Experience 2024'], 'Stay Experience August 2024.txt', 'Cleanliness scores dropped to 81 in August. Guests praised the pool.');
  await add('SE9', ['Guest Scores', 'Stay Experience 2024'], 'Stay Experience September 2024.txt', 'Cleanliness recovered to 90 in September after new housekeeping checklists.');
  await add('ENG', ['Engineering'], 'Boiler log 2026.txt', 'The boiler was serviced. Pool pump replaced.');
});
afterAll(async () => { await db.end(); });

describe('rrf', () => {
  it('rewards items high in both lists', () => {
    const s = rrf([[1, 2, 3], [3, 1]]);
    expect([...s.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])).toEqual([1, 3, 2]);
  });
});

describe('hybridSearch', () => {
  it('finds passages with citations', async () => {
    const r = await hybridSearch(d(), { filter: { and: [] }, keywords: none, semantic: 'cleanliness scores', k: 5 });
    expect(r[0].file).toMatch(/Stay Experience/);
    expect(r[0]).toMatchObject({ link: expect.stringMatching(/^https:\/\/sp\//), heading: null });
    expect(r[0].text).toMatch(/Cleanliness/);
  });

  it('applies the boolean filter and must/not keywords', async () => {
    const aug = await hybridSearch(d(), { filter: { field: 'period', from: '2024-08-01', to: '2024-08-31' }, keywords: none, semantic: 'cleanliness', k: 5 });
    expect(aug.map(p => p.file)).toEqual(['Stay Experience August 2024.txt']);
    const pool = await hybridSearch(d(), { filter: { and: [] }, keywords: { must: ['pool'], should: [], not: ['boiler'] }, semantic: 'pool', k: 5 });
    expect(pool.map(p => p.file)).toEqual(['Stay Experience August 2024.txt']);
  });

  it('handles apostrophes and empty results', async () => {
    expect(await hybridSearch(d(), { filter: { field: 'dataset', eq: "GL's" }, keywords: { must: ["O'Brien's"], should: [], not: [] }, semantic: "O'Brien's", k: 5 })).toEqual([]);
  });
});
