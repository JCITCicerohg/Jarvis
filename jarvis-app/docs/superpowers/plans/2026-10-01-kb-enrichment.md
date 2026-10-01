# KB Enrichment (Plan 5 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Hilton PBI file useful and findable: read legacy `.xls` inventories, split sectioned Labor Summary reports into real tables, OCR scans, give each document an AI summary and each chunk a one-line context sentence plus entity tags, search in two stages (files, then passages), and turn Stay Experience PDFs into a metrics table so guest-score trends are queries.

**Architecture:** All changes sit inside the ingest pipeline and query layer built in Plans 1–4. New parsing (`xls`, OCR) plugs into `parseFile`; the sectioned-report normalizer extends `normalizeSheet` to return several tables per sheet; one Haiku call per text document (`enrichDocument`, structured JSON) yields summary, entities and per-chunk sentences; a deterministic extractor reads Stay Experience PDFs into `metrics`. Generation DDL gains `entities`, `metrics`, chunk `context_sentence`/`entity_ids` and a summary index. Because these change how knowledge is built, the owner rebuilds into a new generation after deploying (Plan 3 gate + cutover).

**Tech Stack:** existing kb-service stack; SheetJS (`xlsx` 0.20.3 from the SheetJS CDN tarball) for `.xls`; `ocrmypdf` + Tesseract (Docker image) behind an `Ocr` interface; the provider-neutral `JsonModel` (Haiku by default).

**Spec:** `jarvis-app/docs/superpowers/specs/2026-09-30-sharepoint-knowledge-base-design.md` (rev 4) §5.4–5.6, §6.1–6.3, §7.1–7.2.

## Global Constraints

- Real formats this plan must handle (verified in the Hilton PBI folder):
  - Inventories are legacy `.xls` BevSpot exports (`August 2026 Hilton Food Inventory.xls`): title rows, then a header row `Product, Package, Count Unit, Price, Price/Oz., Unit Deposit, Distributor, …`.
  - `YYYY-MM-DD__Hilton_PBI_Labor_Summary.xlsx` has sheets `Summary`, `Expanded Summary`, `AvS Data`, `Punch Data`; the two summary sheets contain numbered sections (`1. Actual vs Schedule by Department`, `2. Punch Detail - Labor Totals`, `3. Exceptions to Review`), each a header row plus rows until a blank row, and a line `Business date: Wednesday 9/2/2026 | …`.
  - Stay Experience PDFs (`Hilton PBI Stay Experience August 2024.pdf`) list metrics as `<Name> <responses> <value>[%] <change>[%] vs Same Time Last Year (…)` or `… No comparison`, a `Feedback Date : Aug 1, 2024 to Aug 31, 2024` filter line, and a `Top 5 Problem Topics` table; PDF text splits ligatures (`O ffi ce`, `Sta ff`).
- Enrichment: one JSON-schema call per text document (PDF, Word, PowerPoint, text), at most 40 chunks per call, summary 3–5 sentences, ≤ 30 entities per call, exactly one sentence per chunk; on failure the document is still indexed without enrichment. `KB_ENRICH=0` turns it off. Spreadsheets get their first sheet descriptor as summary (no AI call).
- Two-stage retrieval: stage 1 picks the top 20 documents by summary similarity under the filter; stage 2 restricts passages to those documents plus any document without a summary. Stage 1 is skipped while 20 or fewer documents have summaries.
- Entity filter: field `entity` (exact, case-insensitive name match through `entity_ids`) is usable by the planner; numeric queries ignore it.
- Metrics: Stay Experience metrics are written to `metrics` (one row per metric per report); questions use `measure.dataset = "metrics"`, `measure.field = <metric name>`; `sum` on a metric becomes `avg`.
- OCR runs only where `tesseract` and `ocrmypdf` exist (the Docker image installs them); without them, images stay unsupported and empty PDF pages stay empty.
- Secrets rules from Plans 1–4 stand.

## Review Focus

1. **A Labor Summary whose sections have blank spacer columns or a note row** (`Amounts include $129.12 PTO pay…`): tables still type their number columns correctly. Test in Task 2.
2. **The enrichment model returns fewer sentences than chunks, or fails:** chunks still get indexed (missing sentences empty), document not marked error. Test in Task 4.
3. **A folder move after enrichment:** chunk context keeps its sentence after re-tagging. Test in Task 4.
4. **Stage 1 narrowing hides a document that has no summary** (enrichment failed): it must still be searchable. Test in Task 5.
5. **Ligature-split PDF text** (`Sta ff Position - Front Desk`): extracted topic and metric names come out clean. Test in Task 6.

## Execution note

Run after Plans 2–4 are merged. After deploying Plan 5, trigger a rebuild (Jarvis: "rebuild the knowledge base" → `kb_build`), wait for `ready`, then cut over.

---

### Task 1: Legacy `.xls` workbooks

**Files:**
- Modify: `kb-service/package.json` (dependency `xlsx`)
- Modify: `kb-service/src/parse/sheets.ts`, `kb-service/src/parse/index.ts`
- Modify: `kb-service/test/parse.test.ts`

**Interfaces:**
- Produces: `parseXls(bytes: Buffer): Parsed` (same contract as `parseXlsx`); `parseFile('x.xls', …)` returns sheets.

- [ ] **Step 1: Install and write the failing test**

Run (from `kb-service/`): `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`

In `kb-service/test/parse.test.ts`:
1. Add `import * as XLSX from 'xlsx';`.
2. Delete the line `expect((await parseFile('old.xls', Buffer.from([1]))).kind).toBe('unsupported');`.
3. Add:
```ts
  it('reads legacy .xls workbooks (BevSpot inventory exports)', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Hilton PBI HUB: Food'],
      ['Product', 'Package', 'Price', 'Distributor'],
      ['Avocado', '60 unit', 89.06, 'Freshpoint'],
      ['Asparagus Large', '11lbs', 49.49, 'Freshpoint'],
    ]), 'Food');
    const bytes = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xls' }));
    const p = await parseFile('August 2026 Hilton Food Inventory.xls', bytes);
    if (p.kind !== 'sheets') throw new Error('expected sheets');
    expect(p.sheets).toEqual([{ name: 'Food', rows: [['Hilton PBI HUB: Food'], ['Product', 'Package', 'Price', 'Distributor'], ['Avocado', '60 unit', 89.06, 'Freshpoint'], ['Asparagus Large', '11lbs', 49.49, 'Freshpoint']] }]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/parse.test.ts` → the new test FAILS (`xls` unsupported).

- [ ] **Step 3: Implement**

In `kb-service/src/parse/sheets.ts` add:
```ts
import * as XLSX from 'xlsx';

/** Legacy BIFF .xls workbooks (exceljs reads only .xlsx). */
export function parseXls(bytes: Buffer): Parsed {
  const wb = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  const sheets: SheetData[] = [];
  for (const name of wb.SheetNames) {
    const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
    const t = tidy(raw.map(r => r.map(cellValue)));
    if (t.some(r => r.length)) sheets.push({ name, rows: t });
  }
  return { kind: 'sheets', sheets };
}
```
In `kb-service/src/parse/index.ts`, import `parseXls` and replace the `case 'xls':` line with `case 'xls': return parseXls(bytes);`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/parse.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/package.json kb-service/package-lock.json kb-service/src/parse/sheets.ts kb-service/src/parse/index.ts kb-service/test/parse.test.ts
git commit -m "feat(kb): read legacy .xls workbooks (BevSpot inventory exports)"
```

---

### Task 2: Sectioned reports (Labor Summary) and several tables per sheet

**Files:**
- Create: `kb-service/src/sheets/sectioned.ts`
- Modify: `kb-service/src/sheets/normalize.ts` (returns an array)
- Modify: `kb-service/src/ingest/pipeline.ts` (`build` loops over tables)
- Modify: `kb-service/test/gl.test.ts`
- Test: `kb-service/test/sectioned.test.ts`; add to `kb-service/test/ingest.test.ts`

**Interfaces:**
- Produces: `isSectionedReport(rows): boolean`; `businessDate(rows): string | null`; `sectionedReport(rows): { part: string; table: TidyTable }[]`; `type NormalizerName = 'gl-activity-detail' | 'sectioned-report' | 'generic'`; `interface NormalizedTable { normalizer: NormalizerName; part: string | null; table: TidyTable }`; `normalizeSheet(rows): NormalizedTable[]`. Dataset `sheet` labels become `"<sheet>"` or `"<sheet> / <section title>"`.

- [ ] **Step 1: Write the failing tests**

`kb-service/test/sectioned.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/parse/types.ts';
import { businessDate, isSectionedReport, sectionedReport } from '../src/sheets/sectioned.ts';
import { normalizeSheet } from '../src/sheets/normalize.ts';

const _ = null;
// First rows of the real Summary sheet of 2026-09-02__Hilton_PBI_Labor_Summary.xlsx
const LABOR: Cell[][] = [
  ['Hilton Palm Beach Airport (CIC100) - Labor Summary'],
  ['Business date: Wednesday 9/2/2026  |  Source: M3 Labor - Actual vs Schedule (F&B, Hotel) + Punch Detail, run 9/23/2026 10:00 PM ET'],
  [],
  ['1. Actual vs Schedule by Department'],
  ['Group', 'Department', 'Scheduled Hrs', 'Actual Hrs', 'Variance Hrs', 'Variance %', 'Open Punches', 'No-Shows'],
  ['F&B', 'BOH F&B', '54.00', '60.58', '6.58', '12.2%', '-', '-'],
  ['Hotel', 'Engineering', '16.00', '66.91', '50.91', '318.2%', '-', '-'],
  ['Property', 'Property Total', '201.50', '401.17', '199.67', '99.1%', '-', '-'],
  [],
  ['2. Punch Detail - Labor Totals'],
  ['Group', 'Pay Type', 'Total Hours', 'Total Amount'],
  ['F&B', 'Hourly', '80.91', '$6,695.21'],
  ['Hotel', 'Salaried', '80.00', '$2,819.44'],
  ['Amounts include $129.12 PTO pay (8.00 hrs, not in hours).'],
  [],
  ['3. Exceptions to Review'],
  ['Group', 'Department', 'Employee (Job)', _, 'Issue', _, 'Detail'],
  ['F&B', 'BOH F&B', 'CARRION JIMENEZ, RAUL (Line Cook)', _, 'Overtime paid', _, '0.92 OT/DT hrs'],
];

describe('sectioned reports', () => {
  it('recognises the Labor Summary layout and reads the business date', () => {
    expect(isSectionedReport(LABOR)).toBe(true);
    expect(isSectionedReport([['Room', 'Status'], ['101', 'Done']])).toBe(false);
    expect(businessDate(LABOR)).toBe('2026-09-02');
  });

  it('turns each numbered section into its own typed table with the business date', () => {
    const parts = sectionedReport(LABOR);
    expect(parts.map(p => p.part)).toEqual(['Actual vs Schedule by Department', 'Punch Detail - Labor Totals', 'Exceptions to Review']);
    const avs = parts[0].table;
    expect(avs.period).toEqual({ start: '2026-09-02', end: '2026-09-02' });
    expect(avs.columns.slice(0, 5)).toEqual([
      { name: 'business_date', type: 'date' }, { name: 'group', type: 'text' }, { name: 'department', type: 'text' },
      { name: 'scheduled_hrs', type: 'number' }, { name: 'actual_hrs', type: 'number' },
    ]);
    expect(avs.rows[1]).toMatchObject({ business_date: '2026-09-02', department: 'Engineering', scheduled_hrs: 16, actual_hrs: 66.91 });
    const punch = parts[1].table;
    expect(punch.columns.find(c => c.name === 'total_amount')).toEqual({ name: 'total_amount', type: 'number' });
    expect(punch.rows.map(r => r.total_amount)).toEqual([6695.21, 2819.44, null]);
    expect(parts[2].table.columns.map(c => c.name)).toEqual(['business_date', 'group', 'department', 'employee_job', 'issue', 'detail']);
  });

  it('normalizeSheet returns one entry per section, GL and generic as single entries', () => {
    expect(normalizeSheet(LABOR).map(n => [n.normalizer, n.part])).toEqual([
      ['sectioned-report', 'Actual vs Schedule by Department'], ['sectioned-report', 'Punch Detail - Labor Totals'], ['sectioned-report', 'Exceptions to Review'],
    ]);
    expect(normalizeSheet([['Room', 'Status'], ['101', 'Done']]).map(n => [n.normalizer, n.part])).toEqual([['generic', null]]);
    expect(normalizeSheet([[1], [2]])).toEqual([]);
  });
});
```

In `kb-service/test/gl.test.ts`, replace the `normalizeSheet` test body with:
```ts
    expect(normalizeSheet(GL)[0].normalizer).toBe('gl-activity-detail');
    expect(normalizeSheet([['Room', 'Status'], ['101', 'Done']])[0].normalizer).toBe('generic');
    expect(normalizeSheet([[1], [2]])).toEqual([]);
```
and rename it `'normalizeSheet picks GL first, then generic, else nothing'`.

Add to `kb-service/test/ingest.test.ts` (inside `describe('ingestFile', …)`):
```ts
  it('stores each Labor Summary section as its own dataset', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Summary');
    for (const r of [
      ['Hilton Palm Beach Airport (CIC100) - Labor Summary'], ['Business date: Wednesday 9/2/2026  |  Source: M3'], [],
      ['1. Actual vs Schedule by Department'], ['Group', 'Department', 'Scheduled Hrs', 'Actual Hrs'], ['F&B', 'BOH F&B', '54.00', '60.58'], [],
      ['2. Punch Detail - Labor Totals'], ['Group', 'Pay Type', 'Total Hours', 'Total Amount'], ['F&B', 'Hourly', '80.91', '$6,695.21'],
    ]) ws.addRow(r);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await ingestFile(d, SRC, item({ driveItemId: 'LAB', name: '2026-09-02__Hilton_PBI_Labor_Summary.xlsx', folders: ['Accounting', 'Labor', '2026', '09 - September'] }), bytes)).toBe('indexed');
    const ds = (await db.query(`SELECT sheet, normalizer, period_start FROM kb_g1.datasets ORDER BY id`)).rows;
    expect(ds).toEqual([
      { sheet: 'Summary / Actual vs Schedule by Department', normalizer: 'sectioned-report', period_start: '2026-09-02' },
      { sheet: 'Summary / Punch Detail - Labor Totals', normalizer: 'sectioned-report', period_start: '2026-09-02' },
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sectioned.test.ts test/gl.test.ts test/ingest.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/src/sheets/sectioned.ts`:
```ts
import { toIsoDate } from '../parse/cells.ts';
import type { Cell } from '../parse/types.ts';
import { genericNormalize } from './generic.ts';
import type { TidyTable } from './types.ts';

const SECTION = /^\s*\d+\.\s+(\S.*)$/;
const filled = (c: Cell) => c !== null && c !== '';

/** "1. Actual vs Schedule by Department" alone on its row → its title, else null. */
function sectionTitle(r: Cell[] = []): string | null {
  const cells = r.filter(filled);
  return cells.length === 1 && typeof cells[0] === 'string' ? SECTION.exec(cells[0])?.[1]?.trim() ?? null : null;
}

export function isSectionedReport(rows: Cell[][]): boolean {
  return rows.filter((r, i) => sectionTitle(r) && (rows[i + 1] ?? []).filter(c => typeof c === 'string' && c.trim()).length >= 2).length >= 2;
}

export function businessDate(rows: Cell[][]): string | null {
  for (const r of rows.slice(0, 6)) {
    for (const c of r) {
      const m = typeof c === 'string' ? /Business date:\s*(?:[A-Za-z]+\s+)?(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(c) : null;
      if (m) return toIsoDate(m[1]);
    }
  }
  return null;
}

/** Each numbered section (header row + rows until a blank row) becomes its own typed table. */
export function sectionedReport(rows: Cell[][]): { part: string; table: TidyTable }[] {
  const date = businessDate(rows);
  const out: { part: string; table: TidyTable }[] = [];
  rows.forEach((row, i) => {
    const title = sectionTitle(row);
    if (!title) return;
    const block: Cell[][] = [];
    for (let j = i + 1; j < rows.length && !sectionTitle(rows[j]); j++) {
      if (!rows[j].some(filled)) { if (block.length) break; continue; }
      block.push(rows[j]);
    }
    const t = block.length >= 2 ? genericNormalize(block) : null;
    if (!t?.rows.length) return;
    if (date) {
      t.columns.unshift({ name: 'business_date', type: 'date' });
      t.rows = t.rows.map(r => ({ business_date: date, ...r }));
      t.period = { start: date, end: date };
    }
    out.push({ part: title, table: t });
  });
  return out;
}
```

`kb-service/src/sheets/normalize.ts` (full file):
```ts
import type { Cell } from '../parse/types.ts';
import { genericNormalize } from './generic.ts';
import { glActivityDetail, isGlActivityDetail } from './gl.ts';
import { isSectionedReport, sectionedReport } from './sectioned.ts';
import type { TidyTable } from './types.ts';

export type NormalizerName = 'gl-activity-detail' | 'sectioned-report' | 'generic';
export interface NormalizedTable { normalizer: NormalizerName; part: string | null; table: TidyTable }

/** Named normalizers first (by layout), then the generic one. A sheet can yield several tables. */
export function normalizeSheet(rows: Cell[][]): NormalizedTable[] {
  if (isGlActivityDetail(rows)) return [{ normalizer: 'gl-activity-detail', part: null, table: glActivityDetail(rows) }];
  if (isSectionedReport(rows)) {
    const parts = sectionedReport(rows);
    if (parts.length) return parts.map(p => ({ normalizer: 'sectioned-report' as const, part: p.part, table: p.table }));
  }
  const t = genericNormalize(rows);
  return t?.rows.length ? [{ normalizer: 'generic', part: null, table: t }] : [];
}
```

In `kb-service/src/ingest/pipeline.ts`, replace the `for (const sheet of parsed.sheets) { … }` loop in `build` with:
```ts
    for (const sheet of parsed.sheets) {
      for (const n of normalizeSheet(sheet.rows)) {
        const label = n.part ? `${sheet.name} / ${n.part}` : sheet.name;
        const context = contextHeader(meta, null);
        sections.push({ heading: `Sheet: ${label}`, page: null, text: describeSheet({ file: item.name, sheet: label, context, table: n.table }) });
        sections.push(...sheetRowSections(n.table, label));
        const key = safeKey('tidy', `g${d.gen}`, src.id, meta.dataset ?? 'misc', `${item.driveItemId}-${label}.parquet`);
        await writeParquet(n.table, await d.blob.localPath(key));
        datasets.push({ sheet: label, normalizer: n.normalizer, table: n.table, key });
      }
    }
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/sectioned.test.ts test/gl.test.ts test/ingest.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/sheets/sectioned.ts kb-service/src/sheets/normalize.ts kb-service/src/ingest/pipeline.ts kb-service/test/sectioned.test.ts kb-service/test/gl.test.ts kb-service/test/ingest.test.ts
git commit -m "feat(kb): split sectioned reports (Labor Summary) into one typed table per section"
```

---

### Task 3: OCR for scans

**Files:**
- Create: `kb-service/src/parse/ocr.ts`
- Modify: `kb-service/src/parse/index.ts` (`parseFile(name, bytes, opts)`), `kb-service/src/ingest/pipeline.ts` (`IngestDeps.ocr`)
- Modify: `kb-service/Dockerfile` (install OCR tools)
- Modify: `kb-service/test/parse.test.ts`
- Test: `kb-service/test/ocr.test.ts`

**Interfaces:**
- Produces: `interface Ocr { pdfPages(bytes: Buffer): Promise<string[]>; image(bytes: Buffer, ext: string): Promise<string> }`; `class CliOcr implements Ocr`; `hasOcrTools(): boolean`; `parseFile(name, bytes, opts?: { ocr?: Ocr })`; `IngestDeps.ocr?: Ocr`.

- [ ] **Step 1: Write the failing tests**

`kb-service/test/ocr.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CliOcr, hasOcrTools, type Ocr } from '../src/parse/ocr.ts';
import { parseFile } from '../src/parse/index.ts';

async function pdfWithBlankPage(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('Typed page about the pool.', { x: 50, y: 700, font, size: 12 });
  doc.addPage();
  return Buffer.from(await doc.save());
}
const fakeOcr: Ocr = { pdfPages: async () => ['Typed page about the pool.', 'Scanned invoice from Sysco total 512.00'], image: async () => 'Receipt: Home Depot 42.10' };

describe('OCR in parseFile', () => {
  it('fills empty PDF pages from OCR, keeping page order', async () => {
    const p = await parseFile('scan.pdf', await pdfWithBlankPage(), { ocr: fakeOcr });
    if (p.kind !== 'text') throw new Error('expected text');
    expect(p.sections.map(s => [s.page, s.text])).toEqual([[1, 'Typed page about the pool.'], [2, 'Scanned invoice from Sysco total 512.00']]);
    expect(p.emptyPages).toEqual([]);
  });

  it('reads images with OCR, and leaves them unsupported without it', async () => {
    expect(await parseFile('receipt.jpg', Buffer.from([1]), { ocr: fakeOcr })).toEqual({ kind: 'text', sections: [{ heading: null, page: 1, text: 'Receipt: Home Depot 42.10' }], emptyPages: [] });
    expect(await parseFile('receipt.png', Buffer.from([1]))).toEqual({ kind: 'unsupported', reason: 'image files need OCR, which is not installed here' });
    expect(await parseFile('blank.png', Buffer.from([1]), { ocr: { ...fakeOcr, image: async () => '' } })).toEqual({ kind: 'unsupported', reason: 'no text found in the image' });
  });
});

describe.skipIf(!hasOcrTools())('CliOcr with real tesseract/ocrmypdf', () => {
  it('reads an image-only PDF page', async () => {
    const pages = await new CliOcr().pdfPages(await pdfWithBlankPage());
    expect(pages).toHaveLength(2);
  }, 120_000);
});
```

In `kb-service/test/parse.test.ts`, change the jpg expectation to:
```ts
    expect(await parseFile('photo.jpg', Buffer.from([1]))).toEqual({ kind: 'unsupported', reason: 'image files need OCR, which is not installed here' });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/ocr.test.ts test/parse.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/src/parse/ocr.ts`:
```ts
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractText, getDocumentProxy } from 'unpdf';

const run = promisify(execFile);

export interface Ocr {
  /** Text of every page after OCR (pages that already had text keep it). */
  pdfPages(bytes: Buffer): Promise<string[]>;
  image(bytes: Buffer, ext: string): Promise<string>;
}

export const hasOcrTools = () =>
  spawnSync('tesseract', ['--version']).status === 0 && spawnSync('ocrmypdf', ['--version']).status === 0;

async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-ocr-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** ocrmypdf + Tesseract (installed in the Docker image). */
export class CliOcr implements Ocr {
  pdfPages(bytes: Buffer): Promise<string[]> {
    return inTemp(async dir => {
      const input = join(dir, 'in.pdf'), output = join(dir, 'out.pdf');
      await writeFile(input, bytes);
      await run('ocrmypdf', ['--skip-text', '--quiet', '-l', 'eng', input, output], { timeout: 10 * 60_000 });
      const pdf = await getDocumentProxy(new Uint8Array(await readFile(output)));
      return (await extractText(pdf, { mergePages: false })).text as string[];
    });
  }

  image(bytes: Buffer, ext: string): Promise<string> {
    return inTemp(async dir => {
      const input = join(dir, `in.${ext}`);
      await writeFile(input, bytes);
      const { stdout } = await run('tesseract', [input, 'stdout', '-l', 'eng'], { timeout: 5 * 60_000, maxBuffer: 20 * 1024 * 1024 });
      return stdout.trim();
    });
  }
}
```

In `kb-service/src/parse/index.ts`:
```ts
import type { Ocr } from './ocr.ts';
const IMAGES = ['jpg', 'jpeg', 'png', 'tif', 'tiff'];

export async function parseFile(name: string, bytes: Buffer, opts: { ocr?: Ocr } = {}): Promise<Parsed> {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (IMAGES.includes(ext)) {
    if (!opts.ocr) return { kind: 'unsupported', reason: 'image files need OCR, which is not installed here' };
    const text = await opts.ocr.image(bytes, ext);
    return text ? { kind: 'text', sections: [{ heading: null, page: 1, text }], emptyPages: [] } : { kind: 'unsupported', reason: 'no text found in the image' };
  }
  switch (ext) {
    case 'pdf': {
      const p = await parsePdf(bytes);
      if (p.kind !== 'text' || !p.emptyPages.length || !opts.ocr) return p;
      const pages = await opts.ocr.pdfPages(bytes);
      const added = p.emptyPages.map(n => ({ heading: null, page: n, text: (pages[n - 1] ?? '').trim() })).filter(s => s.text);
      return {
        kind: 'text',
        sections: [...p.sections, ...added].sort((a, b) => (a.page ?? 0) - (b.page ?? 0)),
        emptyPages: p.emptyPages.filter(n => !(pages[n - 1] ?? '').trim()),
      };
    }
    // …keep the existing docx / pptx / xlsx / xlsm / csv / txt / md / xls cases unchanged…
    default: return { kind: 'unsupported', reason: `${ext || 'extensionless'} files are not indexed` };
  }
}
```
(Move the existing cases into this `switch` unchanged except `pdf` and `default`.)

In `kb-service/src/ingest/pipeline.ts`: add `ocr?: Ocr;` to `IngestDeps` (import the type from `../parse/ocr.ts`) and call `parseFile(item.name, bytes, { ocr: d.ocr })` in `build`.

In `kb-service/Dockerfile`, after `WORKDIR /app` add:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ocrmypdf tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/ocr.test.ts test/parse.test.ts && npx tsc --noEmit && npm test` → all PASS (the real-tools test is skipped on machines without Tesseract). Then `docker build -t kb-service:ocr .` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/parse/ocr.ts kb-service/src/parse/index.ts kb-service/src/ingest/pipeline.ts kb-service/Dockerfile kb-service/test/ocr.test.ts kb-service/test/parse.test.ts
git commit -m "feat(kb): OCR scanned PDF pages and images when Tesseract is available"
```

---

### Task 4: Document enrichment — summaries, context sentences, entity tags

**Files:**
- Create: `kb-service/src/enrich/enrich.ts`
- Modify: `kb-service/src/db/migrate.ts` (`generationDdl` additions)
- Modify: `kb-service/src/ingest/pipeline.ts` (`IngestDeps.enricher`; enrichment before embedding; summaries; entities; retag keeps sentences)
- Test: `kb-service/test/enrich.test.ts`; add to `kb-service/test/ingest.test.ts`

**Interfaces:**
- Consumes: `JsonModel`.
- Produces: `ENTITY_TYPES`, `ENRICH_SCHEMA`, `ENRICH_SYSTEM`, `interface Enrichment { summary: string; entities: { name: string; type: EntityType }[]; sentences: string[] }`, `enrichDocument(model, { file, context, chunks }): Promise<Enrichment>`; `IngestDeps.enricher?: JsonModel`; generation tables `entities (id, name, type)`, chunk columns `context_sentence`, `entity_ids bigint[]`; `documents.summary` + `summary_embedding` filled.

- [ ] **Step 1: Write the failing tests**

`kb-service/test/enrich.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ENRICH_SCHEMA, enrichDocument } from '../src/enrich/enrich.ts';

const model = (fn: (user: string) => unknown) => ({ name: 'fake', calls: 0, async json(_s: string, user: string) { this.calls++; return fn(user); } });

describe('enrichDocument', () => {
  it('returns a summary, de-duplicated entities and one sentence per chunk', async () => {
    const m = model(() => ({ summary: ' Stay scores for August 2024. ', entities: [{ name: 'Front Desk', type: 'other' }, { name: 'front desk', type: 'other' }, { name: 'Sysco', type: 'vendor' }], sentences: ['S1', 'S2'] }));
    const r = await enrichDocument(m, { file: 'a.pdf', context: 'Hilton › Guest Scores', chunks: ['one', 'two'] });
    expect(r).toEqual({ summary: 'Stay scores for August 2024.', entities: [{ name: 'Front Desk', type: 'other' }, { name: 'Sysco', type: 'vendor' }], sentences: ['S1', 'S2'] });
  });

  it('batches 40 chunks per call and pads missing sentences', async () => {
    const m = model(user => ({ summary: 'x', entities: [], sentences: user.includes('[41]') ? ['late'] : Array(39).fill('s') }));
    const r = await enrichDocument(m, { file: 'big.pdf', context: 'c', chunks: Array.from({ length: 45 }, (_, i) => `chunk ${i}`) });
    expect(m.calls).toBe(2);
    expect(r.sentences).toHaveLength(45);
    expect(r.sentences[39]).toBe('');
    expect(r.sentences[40]).toBe('late');
  });

  it('rejects malformed output', async () => {
    await expect(enrichDocument(model(() => ({ summary: 1 })), { file: 'a', context: 'c', chunks: ['x'] })).rejects.toThrow(/invalid output/);
    expect(ENRICH_SCHEMA.required).toEqual(['summary', 'entities', 'sentences']);
  });
});
```

Add to `kb-service/test/ingest.test.ts`:
```ts
describe('enrichment', () => {
  const enricher = { name: 'fake', json: async () => ({ summary: 'Pool maintenance notes for 2026.', entities: [{ name: 'Pool Pump Co', type: 'vendor' }], sentences: ['From the pool notes: the pump.'] }) };

  it('stores the summary, a context sentence per chunk and entity tags', async () => {
    await ingestFile({ ...d, enricher }, SRC, item({ driveItemId: 'TXT', name: 'pool.txt', folders: ['Engineering'] }), Buffer.from('The pool pump was replaced.'));
    const doc = (await db.query(`SELECT summary, summary_embedding IS NOT NULL AS emb FROM kb_g1.documents WHERE drive_item_id = 'TXT'`)).rows[0];
    expect(doc).toEqual({ summary: 'Pool maintenance notes for 2026.', emb: true });
    const c = (await db.query(`SELECT context, context_sentence, cardinality(entity_ids) n FROM kb_g1.chunks LIMIT 1`)).rows[0];
    expect(c.context_sentence).toBe('From the pool notes: the pump.');
    expect(c.context).toContain('From the pool notes: the pump.');
    expect(c.n).toBe(1);
    expect((await db.query(`SELECT name, type FROM kb_g1.entities`)).rows).toEqual([{ name: 'Pool Pump Co', type: 'vendor' }]);
  });

  it('still indexes when enrichment fails, and uses the sheet descriptor as a spreadsheet summary', async () => {
    const broken = { name: 'x', json: async () => { throw new Error('model down'); } };
    expect(await ingestFile({ ...d, enricher: broken }, SRC, item({ driveItemId: 'T2', name: 'notes.txt' }), Buffer.from('Some notes.'))).toBe('indexed');
    await ingestFile({ ...d, enricher: broken }, SRC, item(), await glBook());
    const s = (await db.query(`SELECT summary FROM kb_g1.documents WHERE drive_item_id = 'ITEM1'`)).rows[0].summary;
    expect(s.startsWith('Spreadsheet "08.2026 General_Ledger_Activity_Detail.xlsx"')).toBe(true);
  });

  it('keeps context sentences when a folder rename re-tags chunks', async () => {
    await upsertFolder(d, SRC, { driveItemId: 'F-ENG', parentId: null, name: 'Engineering', folders: ['Engineering'] });
    await ingestFile({ ...d, enricher }, SRC, item({ driveItemId: 'TXT', name: 'pool.txt', folders: ['Engineering'] }), Buffer.from('The pool pump was replaced.'));
    await upsertFolder(d, SRC, { driveItemId: 'F-ENG', parentId: null, name: 'Maintenance', folders: ['Maintenance'] });
    const c = (await db.query(`SELECT context FROM kb_g1.chunks LIMIT 1`)).rows[0].context;
    expect(c).toContain('Maintenance');
    expect(c).toContain('From the pool notes: the pump.');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/enrich.test.ts test/ingest.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/src/enrich/enrich.ts`:
```ts
import { z } from 'zod';
import type { JsonModel } from '../llm/json-model.ts';

export const ENTITY_TYPES = ['vendor', 'person', 'account', 'outlet', 'project', 'other'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENRICH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'entities', 'sentences'],
  properties: {
    summary: { type: 'string' },
    entities: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: [...ENTITY_TYPES] } } } },
    sentences: { type: 'array', items: { type: 'string' } },
  },
};

const Out = z.object({
  summary: z.string(),
  entities: z.array(z.object({ name: z.string(), type: z.enum(ENTITY_TYPES) })),
  sentences: z.array(z.string()),
});

export const ENRICH_SYSTEM = `You prepare a hotel company's document for search. You get its file name, its folder location and numbered chunks.
- summary: 3 to 5 sentences on what the document is and its key facts and figures.
- entities: vendors, people, GL accounts, outlets (restaurants, bars, venues) and projects named in the chunks, at most 30, each with a type.
- sentences: exactly one short sentence per chunk, in order, saying where the chunk sits in the document and what it covers, e.g. "From the August 2024 Stay Experience report: cleanliness scores by week."`;

export interface Enrichment { summary: string; entities: { name: string; type: EntityType }[]; sentences: string[] }
const BATCH = 40;

export async function enrichDocument(model: JsonModel, doc: { file: string; context: string; chunks: string[] }): Promise<Enrichment> {
  let summary = '';
  const entities = new Map<string, { name: string; type: EntityType }>();
  const sentences: string[] = [];
  for (let i = 0; i < doc.chunks.length; i += BATCH) {
    const part = doc.chunks.slice(i, i + BATCH);
    const user = `File: ${doc.file}\nLocation: ${doc.context}\n\n` + part.map((c, j) => `[${i + j + 1}]\n${c.slice(0, 1500)}`).join('\n\n');
    const p = Out.safeParse(await model.json(ENRICH_SYSTEM, user, ENRICH_SCHEMA));
    if (!p.success) throw new Error('enrichment returned invalid output: ' + p.error.message.slice(0, 200));
    if (!summary) summary = p.data.summary.trim();
    for (const e of p.data.entities) {
      const name = e.name.trim();
      if (name && !entities.has(`${e.type}:${name.toLowerCase()}`)) entities.set(`${e.type}:${name.toLowerCase()}`, { name, type: e.type });
    }
    part.forEach((_, j) => sentences.push((p.data.sentences[j] ?? '').trim()));
  }
  return { summary, entities: [...entities.values()].slice(0, 60), sentences };
}
```

In `kb-service/src/db/migrate.ts`, inside `generationDdl`, insert before the `kb_query` grants block:
```sql
ALTER TABLE ${s}.chunks ADD COLUMN IF NOT EXISTS context_sentence text;
ALTER TABLE ${s}.chunks ADD COLUMN IF NOT EXISTS entity_ids bigint[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS ${s}_chunks_entities ON ${s}.chunks USING gin (entity_ids);
CREATE TABLE IF NOT EXISTS ${s}.entities (id bigserial PRIMARY KEY, name text NOT NULL, type text NOT NULL, UNIQUE (name, type));
CREATE INDEX IF NOT EXISTS ${s}_documents_summary ON ${s}.documents USING hnsw (summary_embedding vector_cosine_ops);
```

In `kb-service/src/ingest/pipeline.ts`:
1. Imports: `import { enrichDocument, type Enrichment } from '../enrich/enrich.ts';` and `import type { JsonModel } from '../llm/json-model.ts';`. Add `enricher?: JsonModel;` to `IngestDeps`.
2. `build` returns, in addition, `textDoc: parsed.kind === 'text'` and `summary`: for sheets, the first descriptor text cut to 800 characters (`sections.find(s => s.heading?.startsWith('Sheet: '))?.text.slice(0, 800) ?? null`), for text documents `null`.
3. Change `writeContent`'s signature to add `extra: { sentences: string[]; entities: Enrichment['entities'] }` as the last parameter. At its start, after the two DELETEs:
```ts
  const entityIds: number[] = [];
  for (const e of extra.entities) {
    const r = await tx.query(`INSERT INTO ${s}.entities (name, type) VALUES ($1, $2) ON CONFLICT (name, type) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [e.name, e.type]);
    entityIds.push(Number(r.rows[0].id));
  }
```
and change the chunk INSERT to:
```ts
      const sentence = extra.sentences[e] || null;
      await tx.query(
        `INSERT INTO ${s}.chunks (section_id, document_id, ord, page, context, context_sentence, text, tokens, embedding, hotel, department, dataset, period_start, period_end, file_type, entity_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11,$12,$13,$14,$15,$16)`,
        [sec.rows[0].id, docId, c.ord, c.page, sentence ? `${context}\n${sentence}` : context, sentence, c.text, c.tokens, vec(embeddings[e]),
          meta.hotel, meta.department, meta.dataset, meta.period.start, meta.period.end, meta.fileType, entityIds],
      );
      e++;
```
(replacing the old `vec(embeddings[e++])` usage).
4. In `ingestFile`, replace the lines from `const children = …` to the end of the `withTx` with:
```ts
    const flat = built.parents.flatMap(p => p.children.map(c => ({ heading: p.heading, text: c.text })));
    let enrichment: Enrichment | null = null;
    if (d.enricher && built.textDoc && flat.length) {
      try { enrichment = await enrichDocument(d.enricher, { file: item.name, context: contextHeader(meta, null), chunks: flat.map(c => c.text) }); }
      catch (e) { console.warn(`enrichment skipped for ${item.name}: ${(e as Error).message}`); }
    }
    const sentences = enrichment?.sentences ?? [];
    const children = flat.map((c, i) => [contextHeader(meta, c.heading), sentences[i], c.text].filter(Boolean).join('\n'));
    const embeddings = children.length ? await d.embedder.embed(children) : [];
    const summary = enrichment?.summary || built.summary;
    const summaryEmbedding = summary ? (await d.embedder.embed([summary]))[0] : null;
    await withTx(d.db, async tx => {
      const id = await upsertDoc(tx, s, item, meta, { status: 'indexed', hash });
      await writeContent(tx, s, id, meta, built.parents, embeddings, built.datasets, { sentences, entities: enrichment?.entities ?? [] });
      await tx.query(`UPDATE ${s}.documents SET summary = $2, summary_embedding = $3::vector WHERE id = $1`, [id, summary ?? null, summaryEmbedding ? vec(summaryEmbedding) : null]);
    });
```
5. In `retagChunks`, change the chunk update so the sentence survives:
```ts
      `UPDATE ${s}.chunks SET context = $2 || coalesce(E'\\n' || context_sentence, ''), hotel=$3, department=$4, dataset=$5, period_start=$6, period_end=$7, file_type=$8 WHERE section_id=$1`,
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/enrich.test.ts test/ingest.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/enrich/enrich.ts kb-service/src/db/migrate.ts kb-service/src/ingest/pipeline.ts kb-service/test/enrich.test.ts kb-service/test/ingest.test.ts
git commit -m "feat(kb): AI summaries, per-chunk context sentences and entity tags"
```

---

### Task 5: Two-stage retrieval and the entity filter

**Files:**
- Modify: `kb-service/src/query/filter.ts` (`entity` field; `opts.schema`, `opts.skip`)
- Modify: `kb-service/src/search/hybrid.ts` (stage 1 on summaries)
- Modify: `kb-service/src/query/numeric.ts` (skip `entity`)
- Modify: `kb-service/src/query/plan.ts`, `kb-service/src/query/planner.ts`, `kb-service/src/query/catalog.ts`, `kb-service/src/query/validate.ts` (entity in plans and catalog)
- Test: add to `kb-service/test/filter.test.ts`, `kb-service/test/hybrid.test.ts`, `kb-service/test/validate.test.ts`

**Interfaces:**
- Produces: `FilterField` gains `'entity'`; `compileFilter(f, params, alias, opts: { schema?: string; skip?: (FilterField | 'period')[] } = {})`; `STAGE1_DOCS = 20`; `Catalog.entities?: string[]`, `Catalog.metrics?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `kb-service/test/filter.test.ts`:
```ts
  it('compiles entity filters through the generation entities table and skips fields on request', () => {
    const params: unknown[] = [];
    expect(compileFilter({ field: 'entity', eq: 'Sysco' }, params, 'c', { schema: 'kb_g1' }))
      .toBe('EXISTS (SELECT 1 FROM kb_g1.entities e WHERE e.id = ANY(c.entity_ids) AND lower(e.name) = lower($1))');
    expect(params).toEqual(['Sysco']);
    expect(() => compileFilter({ field: 'entity', eq: 'x' }, [], 'c')).toThrow(/schema/);
    expect(compileFilter({ and: [{ field: 'entity', eq: 'x' }, { field: 'hotel', eq: 'H' }] }, [], 'x', { skip: ['entity'] })).toBe('(TRUE AND lower(x.hotel) = lower($1))');
  });
```

Add to `kb-service/test/hybrid.test.ts` (new `describe`, own fixtures):
```ts
describe('two-stage retrieval', () => {
  it('narrows passages to the best-matching documents once enough have summaries, without hiding unsummarized ones', async () => {
    const { freshDb } = await import('./helpers.ts');
    const db2 = await freshDb();
    const deps = { db: db2, gen: 1, blob: new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-2s-'))), embedder: new FakeEmbedder() };
    const withSummary = (summary: string) => ({ name: 'f', json: async () => ({ summary, entities: [], sentences: [''] }) });
    const add = (id: string, text: string, summary: string | null) => ingestFile(summary ? { ...deps, enricher: withSummary(summary) } : deps, SRC,
      { sourceId: 'hilton-pbi', driveItemId: id, parentId: null, name: `${id}.txt`, folders: [], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from(text));
    for (let i = 0; i < 21; i++) await add(`F${i}`, `filler text number ${i}`, 'zebra herd report');
    await add('P', 'zebra stripes in the lobby mural', 'pool maintenance');
    await add('N', 'zebra print carpet order', null);
    const files = (await hybridSearch({ db: db2, gen: 1, embedder: deps.embedder }, { filter: { and: [] }, keywords: none, semantic: 'zebra', k: 30 })).map(p => p.file);
    expect(files).not.toContain('P.txt');
    expect(files).toContain('N.txt');
    await db2.end();
  });
});
```

Add to `kb-service/test/validate.test.ts` (inside `describe('validatePlan', …)`):
```ts
  it('accepts entity filters that exist in the catalog', () => {
    const { plan, notes } = validatePlan(base({ all: [{ field: 'entity', value: 'sysco' }, { field: 'entity', value: 'Nobody' }] }), { ...CATALOG, entities: ['Sysco'] });
    expect(plan.filter).toEqual({ and: [{ field: 'entity', eq: 'Sysco' }] });
    expect(notes).toEqual(['No entity called "Nobody" in the knowledge base; searched without that filter.']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/filter.test.ts test/hybrid.test.ts test/validate.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/src/query/filter.ts` (full file):
```ts
export type FilterField = 'hotel' | 'department' | 'dataset' | 'file_type' | 'entity';
export type Filter =
  | { and: Filter[] } | { or: Filter[] } | { not: Filter }
  | { field: FilterField; eq: string }
  | { field: 'period'; from: string; to: string };

const COLUMNS: Record<Exclude<FilterField, 'entity'>, string> = { hotel: 'hotel', department: 'department', dataset: 'dataset', file_type: 'file_type' };

export interface FilterOptions { schema?: string; skip?: (FilterField | 'period')[] }

/** Compiles a filter tree to SQL over `alias`; every value is a bound parameter appended to `params`. */
export function compileFilter(f: Filter, params: unknown[], alias: string, opts: FilterOptions = {}): string {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if ('and' in f) return f.and.length ? `(${f.and.map(x => compileFilter(x, params, alias, opts)).join(' AND ')})` : 'TRUE';
  if ('or' in f) return f.or.length ? `(${f.or.map(x => compileFilter(x, params, alias, opts)).join(' OR ')})` : 'TRUE';
  if ('not' in f) return `NOT (${compileFilter(f.not, params, alias, opts)})`;
  if (opts.skip?.includes(f.field)) return 'TRUE';
  if (f.field === 'period') {
    const from = p(f.from), to = p(f.to);
    return `(${alias}.period_start <= ${to}::date AND coalesce(${alias}.period_end, ${alias}.period_start) >= ${from}::date)`;
  }
  if (f.field === 'entity') {
    if (!opts.schema) throw new Error('entity filters need the generation schema');
    return `EXISTS (SELECT 1 FROM ${opts.schema}.entities e WHERE e.id = ANY(${alias}.entity_ids) AND lower(e.name) = lower(${p(f.eq)}))`;
  }
  const col = COLUMNS[f.field];
  if (!col) throw new Error(`unknown filter field ${String((f as { field: unknown }).field)}`);
  return `lower(${alias}.${col}) = lower(${p(f.eq)})`;
}
```

In `kb-service/src/search/hybrid.ts`:
1. Export `const STAGE1_DOCS = 20;`.
2. In `build()`, use `compileFilter(input.filter, params, 'c', { schema: s })` and, when `restrict` is set, push `(c.document_id = ANY($k::bigint[]) OR c.document_id IN (SELECT id FROM ${s}.documents WHERE summary_embedding IS NULL))` with the ids bound as `$k`.
3. Before the two candidate queries, compute stage 1:
```ts
  const summarized = Number((await d.db.query(`SELECT count(*)::int AS n FROM ${s}.documents WHERE summary_embedding IS NOT NULL`)).rows[0].n);
  let restrict: number[] | null = null;
  if (summarized > STAGE1_DOCS) {
    const p1: unknown[] = [];
    const w1 = compileFilter(input.filter, p1, 'd', { schema: s, skip: ['entity'] });
    p1.push(vec(qv));
    restrict = (await d.db.query(
      `SELECT d.id FROM ${s}.documents d WHERE ${w1} AND d.summary_embedding IS NOT NULL ORDER BY d.summary_embedding <=> $${p1.length}::vector LIMIT ${STAGE1_DOCS}`, p1,
    )).rows.map(r => Number(r.id));
  }
```
and make `build()` close over `restrict`:
```ts
    if (restrict) { params.push(restrict); where.push(`(c.document_id = ANY($${params.length}::bigint[]) OR c.document_id IN (SELECT id FROM ${s}.documents WHERE summary_embedding IS NULL))`); }
```

In `kb-service/src/query/numeric.ts`, change the filter call to `compileFilter(plan.filter, params, 'x', { skip: ['entity'] })`.

In `kb-service/src/query/plan.ts`, change `Cond`'s field enum to `z.enum(['hotel', 'department', 'dataset', 'file_type', 'entity'])`.
In `kb-service/src/query/planner.ts`, change `cond`'s field enum the same way and add to `PLANNER_SYSTEM` after the `all:` line: `- entity filters (field "entity"): exact names from catalog.entities — vendors, people, GL accounts, outlets, projects. Prefer them over keywords when the name is in the catalog.`
In `kb-service/src/query/catalog.ts`: add `entities?: string[]; metrics?: string[];` to `Catalog`, and in `loadCatalog` add:
```ts
  const entities = (await db.query(
    `SELECT e.name FROM ${s}.entities e JOIN ${s}.chunks c ON e.id = ANY(c.entity_ids) GROUP BY e.name ORDER BY count(*) DESC, e.name LIMIT 300`)).rows.map(r => r.name as string);
```
returning `entities` in the object (metrics are added in Task 6).
In `kb-service/src/query/validate.ts`, add `entity: c => c.entities ?? [],` to `LISTS`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/filter.test.ts test/hybrid.test.ts test/validate.test.ts test/planner.test.ts && npx tsc --noEmit && npm test` → all PASS (the planner schema test still matches zod keys).

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/query kb-service/src/search/hybrid.ts kb-service/test/filter.test.ts kb-service/test/hybrid.test.ts kb-service/test/validate.test.ts
git commit -m "feat(kb): two-stage retrieval on document summaries and an exact entity filter"
```

---

### Task 6: Stay Experience metrics

**Files:**
- Create: `kb-service/src/extract/stay-experience.ts`
- Modify: `kb-service/src/db/migrate.ts` (`metrics` table in `generationDdl`)
- Modify: `kb-service/src/ingest/pipeline.ts` (extract and store metrics for matching PDFs)
- Modify: `kb-service/src/query/catalog.ts` (`metrics`), `kb-service/src/query/validate.ts` (metric measures), `kb-service/src/query/numeric.ts` (`runMetric`), `kb-service/src/query/executor.ts` (dispatch), `kb-service/src/query/planner.ts` (prompt line)
- Test: `kb-service/test/stay-experience.test.ts`; add to `kb-service/test/executor.test.ts` and `kb-service/test/validate.test.ts`

**Interfaces:**
- Produces: `STAY_METRICS`; `normalizePdfText(text): string`; `isStayExperience(text): boolean`; `extractStayExperience(text): { periodStart: string | null; periodEnd: string | null; metrics: { metric: string; value: number; unit: string; responses: number | null; vsLastYear: number | null }[] }` (topics become metrics `Top problem: <topic>` with unit `mentions`); table `metrics (id, document_id, hotel, metric, period_start, period_end, value, unit, responses, vs_last_year)`; `runMetric(d, plan)` (same return shape as `runMeasure`).

- [ ] **Step 1: Write the failing tests**

`kb-service/test/stay-experience.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { extractStayExperience, isStayExperience, normalizePdfText } from '../src/extract/stay-experience.ts';

// Text of pages 1–2 of "Hilton PBI Stay Experience August 2024.pdf" as the PDF extractor returns it.
const PAGE = `Stay Score   79  65.9%  -21.6%   vs Same Time Last Year (87.5%)  Review Site Index   232  86.7  -29.5   vs Same Time Last Year (116.1)   Jun 29, 2026   Jul 13  25.6%  94.0%  Stay Score  Problem Incidence   49  40.8%  No comparison   vs Same Time Last Year (No data)  Problem Resolution   11  36.4%  No comparison   vs Same Time Last Year (No data)  Front O ffi ce Metrics  Service Quality   50  66.0%  No comparison   vs Same Time Last Year (No data)  Honors Appreciation   42  45.2%  No comparison   vs Same Time Last Year (No data)  Housekeeping & Engineering Metrics  Overall Cleanliness   51  78.4%  No comparison   vs Same Time Last Year (No data)  Room Quality   51  62.7%  No comparison   vs Same Time Last Year (No data)  Filters  - :   PBIAH, ORDWB    Feedback Date :   Aug 1, 2024 to Aug 31, 2024      Property :   PBIAH - Hilton Palm Beach PBI   Stay Experience Platform / Daily Download
Food & Beverage Metrics  Breakfast   26  73.1%  No comparison   vs Same Time Last Year (No data)  Restaurant   24  58.3%  No comparison   vs Same Time Last Year (No data)  Restaurant Breakfast  20.0%  Top 5 Problem Topics  Sta ff   Position - Front Desk   67   -3.595  Room Cleanliness - Other/Unspeci fi ed   54   -2.536  Sta ff -SpeedofService   31   -1.426  Very negative   Negative`;

describe('Stay Experience extraction', () => {
  it('repairs split ligatures', () => {
    expect(normalizePdfText('Front O ffi ce  and Sta ff   Position, Unspeci fi ed')).toBe('Front Office and Staff Position, Unspecified');
  });

  it('recognises the report', () => {
    expect(isStayExperience(PAGE)).toBe(true);
    expect(isStayExperience('General ledger detail')).toBe(false);
  });

  it('extracts the period, every metric and the top problem topics', () => {
    const r = extractStayExperience(PAGE);
    expect([r.periodStart, r.periodEnd]).toEqual(['2024-08-01', '2024-08-31']);
    const m = Object.fromEntries(r.metrics.map(x => [x.metric, x]));
    expect(m['Stay Score']).toEqual({ metric: 'Stay Score', value: 65.9, unit: '%', responses: 79, vsLastYear: -21.6 });
    expect(m['Review Site Index']).toEqual({ metric: 'Review Site Index', value: 86.7, unit: '', responses: 232, vsLastYear: -29.5 });
    expect(m['Overall Cleanliness']).toEqual({ metric: 'Overall Cleanliness', value: 78.4, unit: '%', responses: 51, vsLastYear: null });
    expect(m['Breakfast'].value).toBe(73.1);
    expect(m['Restaurant'].value).toBe(58.3);
    expect(m['Top problem: Staff Position - Front Desk']).toEqual({ metric: 'Top problem: Staff Position - Front Desk', value: 67, unit: 'mentions', responses: null, vsLastYear: null });
    expect(m['Top problem: Room Cleanliness - Other/Unspecified'].value).toBe(54);
    expect(r.metrics.filter(x => !x.metric.startsWith('Top problem')).map(x => x.metric)).toEqual([
      'Stay Score', 'Review Site Index', 'Problem Incidence', 'Problem Resolution', 'Service Quality', 'Honors Appreciation', 'Overall Cleanliness', 'Room Quality', 'Breakfast', 'Restaurant',
    ]);
  });
});
```

Add to `kb-service/test/validate.test.ts`:
```ts
  it('turns a metrics measure into an average over the named metric', () => {
    const cat = { ...CATALOG, metrics: ['Stay Score', 'Overall Cleanliness'] };
    const ok = validatePlan(base({ intent: 'trend', measure: { dataset: 'metrics', agg: 'sum', field: 'stay score', where_text: [], group_by: ['month'] } }), cat);
    expect(ok.plan.measure).toEqual({ dataset: 'metrics', agg: 'avg', field: 'Stay Score', whereText: [], groupBy: 'month' });
    const bad = validatePlan(base({ intent: 'trend', measure: { dataset: 'metrics', agg: 'avg', field: 'Pool Score', where_text: [], group_by: [] } }), cat);
    expect(bad.plan.measure).toBeNull();
    expect(bad.notes[0]).toMatch(/No metric called "Pool Score"/);
  });
```

Add to `kb-service/test/executor.test.ts` (inside `describe('runQuery', …)`):
```ts
  it('answers a guest-score trend from the metrics table', async () => {
    const doc = (await db.query(`SELECT id FROM kb_g1.documents WHERE drive_item_id = 'SE'`)).rows[0].id;
    await db.query(`INSERT INTO kb_g1.metrics (document_id, hotel, metric, period_start, period_end, value, unit, responses) VALUES
      ($1, 'Hilton Palm Beach PBI', 'Stay Score', '2024-07-01', '2024-07-31', 70, '%', 60), ($1, 'Hilton Palm Beach PBI', 'Stay Score', '2024-08-01', '2024-08-31', 65.9, '%', 79)`, [doc]);
    const r = await runQuery(deps({
      intent: 'trend', all: [{ field: 'hotel', value: 'Hilton Palm Beach PBI' }], any_of_periods: [{ from: '2024-07', to: '2024-09' }], exclude: [], keywords: none,
      semantic: ['stay score trend'], measure: { dataset: 'metrics', agg: 'avg', field: 'Stay Score', where_text: [], group_by: ['month'] }, answer_shape: 'table',
    }), 'stay score trend Jul-Sep 2024', '2026-10-01');
    expect(r.answer_data).toEqual([{ month: '2024-07', value: 70, rows: 1 }, { month: '2024-08', value: 65.9, rows: 1 }]);
    expect(r.coverage.missing).toEqual(['2024-09']);
    expect(r.sources!.map(s => s.file)).toEqual(['Stay Experience August 2024.txt']);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/stay-experience.test.ts test/validate.test.ts test/executor.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/src/extract/stay-experience.ts`:
```ts
export const STAY_METRICS = [
  'Stay Score', 'Review Site Index', 'Problem Incidence', 'Problem Resolution', 'Service Quality', 'Honors Appreciation',
  'Overall Cleanliness', 'Room Quality', 'Breakfast', 'Restaurant',
];

export interface StayMetric { metric: string; value: number; unit: string; responses: number | null; vsLastYear: number | null }

/** PDF text splits ligatures ("O ffi ce", "Sta ff"); rejoin them and collapse whitespace. */
export function normalizePdfText(text: string): string {
  return text.replace(/(\w) (ffi|ffl|ff|fi|fl) ?(?=\w)/g, '$1$2').replace(/\s+/g, ' ').trim();
}

export const isStayExperience = (text: string) => /Stay Experience Platform|Stay Score\s+\d+/.test(text);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isoDay = (s: string) => { const t = Date.parse(`${s} UTC`); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };

export function extractStayExperience(raw: string): { periodStart: string | null; periodEnd: string | null; metrics: StayMetric[] } {
  const text = normalizePdfText(raw);
  const period = /Feedback Date\s*:\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}) to ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/.exec(text);
  const metrics: StayMetric[] = [];
  for (const name of STAY_METRICS) {
    const m = new RegExp(`${esc(name)} (\\d+) (-?[\\d.]+)(%?) (?:(-?[\\d.]+)%? vs Same Time Last Year|No comparison)`).exec(text);
    if (m) metrics.push({ metric: name, value: Number(m[2]), unit: m[3], responses: Number(m[1]), vsLastYear: m[4] === undefined ? null : Number(m[4]) });
  }
  const topics = /Top 5 Problem Topics (.*?)(?: Very negative|$)/.exec(text)?.[1] ?? '';
  for (const t of topics.matchAll(/([A-Za-z][^\d]*?) (\d+) (-?\d+\.\d+)/g)) {
    metrics.push({ metric: `Top problem: ${t[1].trim()}`, value: Number(t[2]), unit: 'mentions', responses: null, vsLastYear: null });
  }
  return { periodStart: period ? isoDay(period[1]) : null, periodEnd: period ? isoDay(period[2]) : null, metrics };
}
```

In `kb-service/src/db/migrate.ts`, inside `generationDdl`, before the grants block:
```sql
CREATE TABLE IF NOT EXISTS ${s}.metrics (
  id bigserial PRIMARY KEY, document_id bigint NOT NULL REFERENCES ${s}.documents(id) ON DELETE CASCADE,
  hotel text, metric text NOT NULL, period_start date, period_end date, value real, unit text, responses int, vs_last_year real);
CREATE INDEX IF NOT EXISTS ${s}_metrics_lookup ON ${s}.metrics (lower(metric), period_start);
```

In `kb-service/src/ingest/pipeline.ts`:
1. Import `extractStayExperience, isStayExperience` from `../extract/stay-experience.ts`.
2. In `build`, for `parsed.kind === 'text'`: `const full = parsed.sections.map(x => x.text).join('\n'); const stay = isStayExperience(full) ? extractStayExperience(full) : null;` and return `metrics: stay ? stay.metrics.map(m => ({ ...m, periodStart: stay.periodStart, periodEnd: stay.periodEnd })) : []` (sheets return `metrics: []`).
3. In `writeContent`, add `metrics` to the `extra` parameter type (`metrics: (StayMetric & { periodStart: string | null; periodEnd: string | null })[]`), delete old rows (`DELETE FROM ${s}.metrics WHERE document_id = $1`) next to the other DELETEs, and insert:
```ts
  for (const m of extra.metrics) {
    await tx.query(
      `INSERT INTO ${s}.metrics (document_id, hotel, metric, period_start, period_end, value, unit, responses, vs_last_year) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [docId, meta.hotel, m.metric, m.periodStart ?? meta.period.start, m.periodEnd ?? meta.period.end, m.value, m.unit, m.responses, m.vsLastYear]);
  }
```
and pass `metrics: built.metrics` from `ingestFile`.

In `kb-service/src/query/catalog.ts`, in `loadCatalog` add `const metrics = (await db.query(`SELECT DISTINCT metric FROM ${s}.metrics WHERE metric NOT LIKE 'Top problem:%' ORDER BY 1`)).rows.map(r => r.metric as string);` and return it.

In `kb-service/src/query/validate.ts`, at the start of the `if (raw.measure) {` block insert:
```ts
    if (raw.measure.dataset.trim().toLowerCase() === 'metrics') {
      const name = (catalog.metrics ?? []).find(x => x.toLowerCase() === raw.measure!.field.trim().toLowerCase());
      if (name) measure = { dataset: 'metrics', agg: raw.measure.agg === 'sum' ? 'avg' : raw.measure.agg, field: name, whereText: [], groupBy: raw.measure.group_by[0] ?? null };
      else notes.push(`No metric called "${raw.measure.field}" in the knowledge base; showing matching documents instead.`);
    } else {
```
and close the `else` after the existing dataset branch (before `if (!measure) { intent = 'doc_question'; … }`).

In `kb-service/src/query/numeric.ts` add:
```ts
/** Guest-score style measures over the metrics table (Postgres). */
export async function runMetric(d: { db: Db; gen: number }, plan: QueryPlan) {
  const m = plan.measure!;
  const s = gschema(d.gen);
  const params: unknown[] = [m.field];
  const where = compileFilter(plan.filter, params, 'm', { skip: ['dataset', 'department', 'file_type', 'entity'] });
  const group = m.groupBy ? { year: `extract(year FROM m.period_start)::int`, month: `to_char(m.period_start, 'YYYY-MM')`, day: `m.period_start::text` }[m.groupBy] : null;
  const agg = { sum: 'avg', avg: 'avg', count: 'count', min: 'min', max: 'max' }[m.agg];
  const rows = (await d.db.query(
    `SELECT ${group ? `${group} AS g, ` : ''}round((${agg === 'count' ? 'count(*)' : `${agg}(m.value)`})::numeric, 2)::float AS value, count(*)::int AS rows
     FROM ${s}.metrics m WHERE lower(m.metric) = lower($1) AND ${where} ${group ? 'GROUP BY 1 ORDER BY 1' : ''}`, params)).rows;
  const docs = (await d.db.query(
    `SELECT DISTINCT doc.name, doc.web_url, m.period_start, m.period_end FROM ${s}.metrics m JOIN ${s}.documents doc ON doc.id = m.document_id
     WHERE lower(m.metric) = lower($1) AND ${where} ORDER BY m.period_start`, params)).rows;
  return {
    rows: rows.map(r => ({ ...(group ? { [m.groupBy!]: r.g } : {}), value: r.value, rows: r.rows })),
    sources: [...new Map(docs.map(x => [x.name as string, {
      file: x.name as string, link: x.web_url as string | null,
      period: x.period_start === x.period_end ? x.period_start : `${x.period_start} to ${x.period_end}`,
    }])).values()],
    presentMonths: [...new Set(docs.flatMap(x => monthsBetween(x.period_start, x.period_end)))],
  };
}
```
(`sources` lists each file once; `presentMonths` still counts every period found.)

In `kb-service/src/query/executor.ts`, import `runMetric` and change `const m = await runMeasure(d, plan);` to `const m = plan.measure.dataset === 'metrics' ? await runMetric(d, plan) : await runMeasure(d, plan);`.

In `kb-service/src/query/planner.ts`, add to `PLANNER_SYSTEM` after the `measure:` line: `- Guest scores (Stay Score, cleanliness, breakfast, service…): measure.dataset = "metrics", measure.field = the metric name from catalog.metrics, agg avg, group_by ["month"] for trends.`

- [ ] **Step 4: Verify**

Run: `npx vitest run test/stay-experience.test.ts test/validate.test.ts test/executor.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/extract kb-service/src/db/migrate.ts kb-service/src/ingest/pipeline.ts kb-service/src/query kb-service/test/stay-experience.test.ts kb-service/test/validate.test.ts kb-service/test/executor.test.ts
git commit -m "feat(kb): Stay Experience metrics table and guest-score trend queries"
```

---

### Task 7: Wiring, switches and the rebuild note

**Files:**
- Modify: `kb-service/src/config.ts` (`enrich`)
- Modify: `kb-service/src/gen/manager.ts` (`ManagerDeps.ocr`, `ManagerDeps.enricher` flow into every `IngestDeps`)
- Modify: `kb-service/src/main.ts` (create `CliOcr` when tools exist; enricher from `createJsonModel` unless `KB_ENRICH=0`)
- Modify: `kb-service/test/manager.test.ts`, `kb-service/test/planner.test.ts` (env helper)
- Modify: `kb-service/.env.example`, `deploy/kb.env.example`, `kb-service/README.md`

**Interfaces:**
- Produces: `Env.enrich: boolean`; `ManagerDeps.ocr?: Ocr`, `ManagerDeps.enricher?: JsonModel`.

- [ ] **Step 1: Write the failing test**

Add to `kb-service/test/manager.test.ts`:
```ts
  it('passes OCR and the enricher into every ingest target', async () => {
    const ocr = { pdfPages: async () => [], image: async () => '' };
    const enricher = { name: 'e', json: async () => ({}) };
    m = new GenerationManager({ ...(m as unknown as { d: ConstructorParameters<typeof GenerationManager>[0] }).d, ocr, enricher });
    const t = await m.targets();
    expect(t.primary).toMatchObject({ ocr, enricher });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/manager.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/src/config.ts`: add `enrich: boolean;` to `Env` and `enrich: e.KB_ENRICH !== '0',` to `loadEnv()`. Add `enrich: true` to `test/planner.test.ts`'s `env()` helper.

`kb-service/src/gen/manager.ts`: add `ocr?: Ocr; enricher?: JsonModel;` to `ManagerDeps` (import the types) and in `ingestDeps` return `{ db: this.d.db, gen: g.id, blob: this.d.blob, embedder: this.d.embedderFor(g.embedding_model), ocr: this.d.ocr, enricher: this.d.enricher }`.

`kb-service/src/main.ts`: import `CliOcr, hasOcrTools` from `./parse/ocr.ts` and `createJsonModel` (already imported in Plan 4); before constructing the manager:
```ts
const ocr = hasOcrTools() ? new CliOcr() : undefined;
const enricher = env.enrich ? createJsonModel(env) : undefined;
console.log(`OCR ${ocr ? 'on' : 'off (tesseract/ocrmypdf not found)'}; enrichment ${enricher ? 'on' : 'off (KB_ENRICH=0)'}`);
```
and pass `ocr, enricher` in the `GenerationManager` deps.

Add to `kb-service/.env.example` and `deploy/kb.env.example`: `KB_ENRICH=1` with comment `# 0 turns off AI summaries / context sentences / entity tags`.

Append to `kb-service/README.md`:
```markdown
## After changing how knowledge is built (e.g. deploying Plan 5)

New parsing, normalizers, OCR, enrichment or a new embedding model only apply to a new generation:

1. Ask Jarvis "rebuild the knowledge base" (or `POST /v1/admin/generations` with an admin key).
2. Watch progress with "show knowledge-base generations"; the gate marks it ready when the build is done, errors are no worse, and eval hit@5 ≥ 0.85 and ≥ live.
3. Ask Jarvis to cut over (you approve). Roll back any time in the next 7 days.
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/manager.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/config.ts kb-service/src/gen/manager.ts kb-service/src/main.ts kb-service/test/manager.test.ts kb-service/test/planner.test.ts kb-service/.env.example deploy/kb.env.example kb-service/README.md
git commit -m "feat(kb): wire OCR and enrichment into every generation; rebuild guide"
```
