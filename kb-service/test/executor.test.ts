import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import type { PlannerOutputT } from '../src/query/plan.ts';
import type { Planner } from '../src/query/planner.ts';
import { runQuery, trimResult, type QueryDeps, type QueryResult } from '../src/query/executor.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, blob: LocalBlobStore;
const fixed = (p: PlannerOutputT): Planner => ({ plan: async () => p });
const deps = (p: PlannerOutputT): QueryDeps => ({ db, gen: 1, embedder: new FakeEmbedder(), blob, planner: fixed(p) });
const none = { must: [], should: [], not: [] };

async function gl(month: number, amazon: number[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  ws.addRow([null, null, null, null, null, 'General Ledger Activity Detail']);
  ws.addRow([null, null, null, null, null, `From ${month}/1/YEAR to ${month}/${last}/YEAR`]);
  ws.addRow([null, 'Post Date', 'Invoice', null, null, null, 'Reference', null, 'Detail Description', null, 'Debit', null, 'Credit']);
  ws.addRow([null, '10050.000', null, null, null, 'Operating Account']);
  for (const a of amazon) ws.addRow([null, `${month}/5/YEAR`, null, null, null, null, 'Manual (Non-Check) Amazon', null, null, null, null, null, String(a)]);
  ws.addRow([null, `${month}/6/YEAR`, null, null, null, null, 'Manual (Non-Check) Sysco', null, null, null, null, null, '500']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  db = await freshDb();
  blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-ex-')));
  const d = { db, gen: 1, blob, embedder: new FakeEmbedder() };
  const add = async (id: string, year: number, month: number, amazon: number[]) => {
    const bytes = await gl(month, amazon);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as unknown as ArrayBuffer);
    book.worksheets[0].eachRow(r => r.eachCell(c => { if (typeof c.value === 'string') c.value = c.value.replace(/YEAR/g, String(year)); }));
    await ingestFile(d, SRC, { sourceId: 'hilton-pbi', driveItemId: id, parentId: null, name: `${String(month).padStart(2, '0')}.${year} General_Ledger_Activity_Detail.xlsx`, folders: ['Accounting', "GL's", String(year)], webUrl: `https://sp/${id}`, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: `${year}-09-01T00:00:00Z` }, Buffer.from(await book.xlsx.writeBuffer()));
  };
  await add('G2601', 2026, 1, [10, 20]);
  await add('G2602', 2026, 2, [5]);
  await add('G2501', 2025, 1, [7]);
  await ingestFile(d, SRC, { sourceId: 'hilton-pbi', driveItemId: 'SE', parentId: null, name: 'Stay Experience August 2024.txt', folders: ['Guest Scores', 'Stay Experience 2024'], webUrl: 'https://sp/SE', mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2024-09-01T00:00:00Z' }, Buffer.from('Cleanliness scores dropped to 81 in August.'));
});
afterAll(async () => { await db.end(); });

describe('runQuery', () => {
  it('answers a numeric comparison from Parquet and reports missing months', async () => {
    const r = await runQuery(deps({
      intent: 'numeric_compare', all: [{ field: 'hotel', value: 'Hilton Palm Beach PBI' }], exclude: [], keywords: none, semantic: ['amazon spend'],
      any_of_periods: [{ from: '2026-01', to: '2026-03' }, { from: '2025-01', to: '2025-03' }],
      measure: { dataset: "GL's", agg: 'sum', field: 'credit', where_text: [{ column: 'reference', contains: 'amazon' }], group_by: ['year'] },
      answer_shape: 'headline+table',
    }), 'Amazon spend Q1 vs last year?', '2026-10-01');
    expect(r.answer_data).toEqual([{ year: 2025, value: 7, rows: 1 }, { year: 2026, value: 35, rows: 3 }]);
    expect(r.coverage.missing).toEqual(['2025-02', '2025-03', '2026-03']);
    expect(r.sources!.map(s => s.file).sort()).toEqual(['01.2025 General_Ledger_Activity_Detail.xlsx', '01.2026 General_Ledger_Activity_Detail.xlsx', '02.2026 General_Ledger_Activity_Detail.xlsx']);
    expect(r.confidence).toBe('medium');
    expect(r.generation).toBe(1);
    const log = (await db.query('SELECT question, rows, confidence FROM kb_meta.query_log ORDER BY id DESC LIMIT 1')).rows[0];
    expect(log).toEqual({ question: 'Amazon spend Q1 vs last year?', rows: 2, confidence: 'medium' });
  });

  it('answers a document question with cited passages', async () => {
    const r = await runQuery(deps({ intent: 'doc_question', all: [], any_of_periods: [], exclude: [], keywords: none, semantic: ['cleanliness scores August'], measure: null, answer_shape: 'answer+quotes' }), 'cleanliness?', '2026-10-01');
    expect(r.passages![0]).toMatchObject({ file: 'Stay Experience August 2024.txt', link: 'https://sp/SE' });
    expect(r.answer_data).toBeUndefined();
  });

  it('lists files for find_files', async () => {
    const r = await runQuery(deps({ intent: 'find_files', all: [{ field: 'dataset', value: "GL's" }], any_of_periods: [], exclude: [], keywords: none, semantic: ['general ledger'], measure: null, answer_shape: 'file_list' }), 'which GL files?', '2026-10-01');
    expect(r.files!.length).toBe(3);
    expect(r.files![0].summary.length).toBeLessThanOrEqual(300);
  });

  it('returns low confidence with notes for things that do not exist', async () => {
    const r = await runQuery(deps({ intent: 'doc_question', all: [{ field: 'hotel', value: 'Marriott Miami' }], any_of_periods: [], exclude: [], keywords: { must: ['zzzqqq'], should: [], not: [] }, semantic: ['zzzqqq'], measure: null, answer_shape: 'answer+quotes' }), 'nothing', '2026-10-01');
    expect(r.passages).toEqual([]);
    expect(r.confidence).toBe('low');
    expect(r.notes[0]).toMatch(/Marriott Miami/);
  });
});

describe('trimResult', () => {
  it('drops the lowest passages until under budget and caps passage length', () => {
    const big: QueryResult = {
      plan: {} as never, coverage: { missing: [] }, notes: [], confidence: 'high', generation: 1,
      passages: Array.from({ length: 20 }, (_, i) => ({ text: 'x'.repeat(3000), heading: null, file: `f${i}`, page: null, link: null, period: null, score: 1 / (i + 1) })),
    };
    const t = trimResult(big, 3000);
    expect(JSON.stringify(t).length / 4).toBeLessThanOrEqual(3000);
    expect(t.passages![0].text.length).toBeLessThanOrEqual(1500);
    expect(t.passages![0].file).toBe('f0');
    expect(t.notes).toContain('Some lower-ranked passages were left out to keep the answer short.');
  });
});
