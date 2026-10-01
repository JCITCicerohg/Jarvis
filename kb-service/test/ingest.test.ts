import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { deleteItem, ingestFile, rawKey, upsertFolder, type IngestDeps, type ItemInfo } from '../src/ingest/pipeline.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, d: IngestDeps;

const item = (over: Partial<ItemInfo> = {}): ItemInfo => ({
  sourceId: 'hilton-pbi', driveItemId: 'ITEM1', parentId: 'F-GL', name: '08.2026 General_Ledger_Activity_Detail.xlsx',
  folders: ['Accounting', "GL's", '2026'], webUrl: 'https://sp/gl', mime: null, size: 1, ctag: 'c1', etag: 'e1', modifiedAt: '2026-09-01T00:00:00Z', ...over,
});

async function glBook(amazon = 54.98): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow([null, null, null, null, null, 'General Ledger Activity Detail']);
  ws.addRow([null, null, null, null, null, 'From 8/1/2026 to 8/31/2026']);
  ws.addRow([null, 'Post Date', 'Invoice', null, null, null, 'Reference', null, 'Detail Description', null, 'Debit', null, 'Credit']);
  ws.addRow([null, '10050.000', null, null, null, 'Operating Account']);
  ws.addRow([null, '8/1/2026', null, null, null, null, 'Manual (Non-Check) Amazon', null, null, null, null, null, String(amazon)]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const count = async (t: string) => Number((await db.query(`SELECT count(*) n FROM kb_g1.${t}`)).rows[0].n);

beforeAll(async () => { db = await freshDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE kb_g1.documents, kb_g1.folders, kb_meta.corrections RESTART IDENTITY CASCADE');
  d = { db, gen: 1, blob: new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-ing-'))), embedder: new FakeEmbedder() };
});
afterAll(async () => { await db.end(); });

describe('ingestFile', () => {
  it('indexes a GL workbook: document, descriptor chunk, dataset with Parquet', async () => {
    expect(await ingestFile(d, SRC, item(), await glBook())).toBe('indexed');
    const doc = (await db.query('SELECT * FROM kb_g1.documents')).rows[0];
    expect(doc).toMatchObject({ status: 'indexed', hotel: 'Hilton Palm Beach PBI', department: 'Accounting', dataset: "GL's", period_start: '2026-08-01', period_grain: 'month', file_type: 'xlsx', path: "Accounting/GL's/2026" });
    const ds = (await db.query('SELECT * FROM kb_g1.datasets')).rows[0];
    expect(ds).toMatchObject({ normalizer: 'gl-activity-detail', row_count: 1, period_start: '2026-08-01', period_end: '2026-08-31', dataset: "GL's" });
    expect(await d.blob.localPath(ds.blob_key)).toMatch(/\.parquet$/);
    const chunk = (await db.query('SELECT context, text, hotel FROM kb_g1.chunks ORDER BY id')).rows;
    expect(chunk[0].context).toBe("Hilton Palm Beach PBI › Accounting › GL's › Aug 2026 › Sheet: Sheet1");
    expect(chunk[0].text).toContain('Manual (Non-Check) Amazon');
  });

  it('is idempotent: same bytes twice → unchanged, no duplicates', async () => {
    const bytes = await glBook();
    await ingestFile(d, SRC, item(), bytes);
    const before = [await count('sections'), await count('chunks'), await count('datasets')];
    expect(await ingestFile(d, SRC, item({ ctag: 'c2' }), bytes)).toBe('unchanged');
    expect([await count('documents'), await count('sections'), await count('chunks'), await count('datasets')]).toEqual([1, ...before]);
  });

  it('replaces all chunks and datasets when content changes', async () => {
    await ingestFile(d, SRC, item(), await glBook(54.98));
    await ingestFile(d, SRC, item({ ctag: 'c2' }), await glBook(99.99));
    expect(await count('documents')).toBe(1);
    expect(await count('datasets')).toBe(1);
    const texts = (await db.query('SELECT text FROM kb_g1.chunks')).rows.map(r => r.text).join(' ');
    expect(texts).toContain('99.99');
    expect(texts).not.toContain('54.98');
  });

  it('records unsupported files as skipped and broken files as error', async () => {
    expect(await ingestFile(d, SRC, item({ driveItemId: 'IMG', name: 'scan.jpg' }), Buffer.from([1]))).toBe('skipped');
    expect(await ingestFile(d, SRC, item({ driveItemId: 'BAD', name: 'broken.xlsx' }), Buffer.from('not a zip'))).toBe('error');
    const rows = (await db.query(`SELECT drive_item_id, status, error, attempts FROM kb_g1.documents ORDER BY drive_item_id`)).rows;
    expect(rows[0]).toMatchObject({ drive_item_id: 'BAD', status: 'error', attempts: 1 });
    expect(rows[0].error).toBeTruthy();
    expect(rows[1]).toMatchObject({ drive_item_id: 'IMG', status: 'skipped' });
  });

  it('writes Parquet under the generation folder', async () => {
    await ingestFile(d, SRC, item(), await glBook());
    const key = (await db.query('SELECT blob_key FROM kb_g1.datasets')).rows[0].blob_key;
    expect(key.startsWith('tidy/g1/hilton-pbi/')).toBe(true);
  });

  it('archives raw bytes under a new cTag even when the content is unchanged', async () => {
    const bytes = await glBook();
    await ingestFile(d, SRC, item({ ctag: 'c1' }), bytes);
    expect(await ingestFile(d, SRC, item({ ctag: 'c9' }), bytes)).toBe('unchanged');
    expect((await d.blob.get(rawKey('hilton-pbi', 'ITEM1', 'c9'))).equals(bytes)).toBe(true);
  });
});

describe('supersession', () => {
  it('sends an overlapping correction to review when a newer official file arrives', async () => {
    const { createCorrection } = await import('../src/corrections/store.ts');
    const c = await createCorrection(db, { text: 'GL closes on the 5th.', original_message: 'x', author: 'owner', scope: 'global', hotel: 'Hilton Palm Beach PBI', department: 'Accounting', dataset: "GL's", entities: [], period_start: null, period_end: null, embedding: [1], embedding_model: 'fake-hash' });
    await ingestFile(d, SRC, item({ modifiedAt: new Date(Date.now() + 60_000).toISOString() }), await glBook());
    const row = (await db.query('SELECT status, superseded_by_item FROM kb_meta.corrections WHERE id = $1', [c.id])).rows[0];
    expect(row).toEqual({ status: 'needs_review', superseded_by_item: 'ITEM1' });
  });

  it('still indexes the file if flagSuperseded fails', async () => {
    try {
      await db.query('ALTER TABLE kb_meta.corrections RENAME TO corrections_off');
      const result = await ingestFile(d, SRC, item({ modifiedAt: new Date(Date.now() + 60_000).toISOString() }), await glBook());
      expect(result).toBe('indexed');
      const doc = (await db.query('SELECT status FROM kb_g1.documents WHERE drive_item_id = $1', ['ITEM1'])).rows[0];
      expect(doc.status).toBe('indexed');
    } finally {
      try {
        await db.query('ALTER TABLE kb_meta.corrections_off RENAME TO corrections');
      } catch {
        // table may not exist if test failed earlier
      }
    }
  });
});

describe('deleteItem / upsertFolder', () => {
  it('deletes a file, and a folder with everything under it', async () => {
    await upsertFolder(d, SRC, { driveItemId: 'F-ACC', parentId: null, name: 'Accounting', folders: ['Accounting'] });
    await ingestFile(d, SRC, item(), await glBook());
    await ingestFile(d, SRC, item({ driveItemId: 'ITEM2', name: 'notes.txt', folders: ['Guest Scores'] }), Buffer.from('Guests loved the pool.'));
    expect(await deleteItem(d, 'hilton-pbi', 'ITEM2')).toBe(1);
    expect(await deleteItem(d, 'hilton-pbi', 'F-ACC')).toBe(1);
    expect(await count('documents')).toBe(0);
    expect(await count('chunks')).toBe(0);
    expect(await deleteItem(d, 'hilton-pbi', 'UNKNOWN')).toBe(0);
  });

  it('re-tags documents when a folder is renamed, without re-embedding', async () => {
    await upsertFolder(d, SRC, { driveItemId: 'F-GL', parentId: 'F-ACC', name: "GL's", folders: ['Accounting', "GL's"] });
    await ingestFile(d, SRC, item({ folders: ['Accounting', "GL's", '2026'] }), await glBook());
    const emb = (await db.query('SELECT embedding::text e FROM kb_g1.chunks LIMIT 1')).rows[0].e;
    expect(await upsertFolder(d, SRC, { driveItemId: 'F-GL', parentId: 'F-ACC', name: 'General Ledger', folders: ['Accounting', 'General Ledger'] })).toBe(1);
    const doc = (await db.query('SELECT path, dataset FROM kb_g1.documents')).rows[0];
    expect(doc).toEqual({ path: 'Accounting/General Ledger/2026', dataset: 'General Ledger' });
    const c = (await db.query('SELECT context, dataset, embedding::text e FROM kb_g1.chunks LIMIT 1')).rows[0];
    expect(c.context).toContain('General Ledger');
    expect(c.dataset).toBe('General Ledger');
    expect(c.e).toBe(emb);
  });
});
