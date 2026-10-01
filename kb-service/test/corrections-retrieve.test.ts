import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { createCorrection, decideCorrection } from '../src/corrections/store.ts';
import { findCorrections } from '../src/corrections/retrieve.ts';
import { runQuery } from '../src/query/executor.ts';
import type { PlannerOutputT } from '../src/query/plan.ts';
import { freshDb, queryDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, q: Db;
const fake = new FakeEmbedder();
const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-cr-')));
const plan = (p: Partial<PlannerOutputT> = {}): PlannerOutputT => ({ intent: 'doc_question', all: [], any_of_periods: [], exclude: [], keywords: { must: [], should: [], not: [] }, semantic: ['lobby renovation schedule'], measure: null, answer_shape: 'answer+quotes', ...p });

beforeAll(async () => {
  db = await freshDb();
  q = queryDb();
  await ingestFile({ db, gen: 1, blob, embedder: fake }, SRC, { sourceId: 'hilton-pbi', driveItemId: 'PR', parentId: null, name: 'Hilton Projects.txt', folders: [], webUrl: 'https://sp/PR', mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('Lobby renovation scheduled to finish in September 2026.'));
  const [emb] = await fake.embed(['The lobby renovation slipped to Q4 2026.']);
  const g = await createCorrection(q, { text: 'The lobby renovation slipped to Q4 2026.', original_message: 'lobby reno slipped to Q4', author: 'owner', scope: 'global', hotel: 'Hilton Palm Beach PBI', department: null, dataset: 'Hilton Projects', entities: ['Lobby renovation'], period_start: null, period_end: null, embedding: emb, embedding_model: 'fake-hash' });
  await decideCorrection(q, g.id, 'approve', 'owner-admin', true);
  const [e2] = await fake.embed(['Exec prefers pool reports weekly.']);
  await createCorrection(q, { text: 'Exec prefers pool reports weekly.', original_message: 'x', author: 'exec', scope: 'personal', hotel: null, department: null, dataset: null, entities: [], period_start: null, period_end: null, embedding: e2, embedding_model: 'fake-hash' });
});
afterAll(async () => { await q.end(); await db.end(); });

describe('corrections in results', () => {
  it('returns visible corrections beside official passages, flagging the contradiction', async () => {
    const r = await runQuery({ db: q, gen: 1, blob, embedder: fake, planner: { plan: async () => plan() } }, 'when does the lobby renovation finish?', '2026-10-01', 'owner');
    expect(r.passages![0].file).toBe('Hilton Projects.txt');
    expect(r.passages!.some(p => p.text.includes('slipped'))).toBe(false);
    expect(r.corrections).toEqual([{ text: 'The lobby renovation slipped to Q4 2026.', author: 'owner', created: expect.any(String), scope: 'global', status: 'approved', contradicts: 'Hilton Projects.txt' }]);
  });

  it("never shows another user's personal correction", async () => {
    const r = await findCorrections({ db: q, embedder: fake }, { user: 'owner', question: 'pool reports weekly', plan: { intent: 'doc_question', filter: { and: [] }, periods: [], keywords: { must: [], should: [], not: [] }, semantic: ['pool reports weekly'], measure: null, answer_shape: 'answer+quotes' }, cited: [] });
    expect(r.map(c => c.text)).not.toContain('Exec prefers pool reports weekly.');
  });

  it('re-embeds a correction stored with another model', async () => {
    const other = new FakeEmbedder(16); other.model = 'fake-16';
    const r = await findCorrections({ db: q, embedder: other }, { user: 'owner', question: 'lobby renovation slipped', plan: { intent: 'doc_question', filter: { and: [] }, periods: [], keywords: { must: [], should: [], not: [] }, semantic: ['lobby renovation slipped'], measure: null, answer_shape: 'answer+quotes' }, cited: [] });
    expect(r[0].text).toContain('lobby renovation');
    expect((await db.query(`SELECT embedding_model FROM kb_meta.corrections WHERE author = 'owner'`)).rows[0].embedding_model).toBe('fake-16');
  });

  it('is omitted when no user is known', async () => {
    const r = await runQuery({ db: q, gen: 1, blob, embedder: fake, planner: { plan: async () => plan() } }, 'lobby', '2026-10-01', null);
    expect(r.corrections).toBeUndefined();
  });
});
