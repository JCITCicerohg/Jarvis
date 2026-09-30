import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { duck, sqlStr } from '../src/duck.ts';
import { writeParquet } from '../src/sheets/parquet.ts';
import { describeSheet, sheetRowSections } from '../src/sheets/describe.ts';
import type { TidyTable } from '../src/sheets/types.ts';

const TABLE: TidyTable = {
  columns: [{ name: 'post_date', type: 'date' }, { name: 'reference', type: 'text' }, { name: 'credit', type: 'number' }],
  rows: [
    { post_date: '2026-08-01', reference: 'Manual (Non-Check) Amazon', credit: 54.98 },
    { post_date: '2026-08-03', reference: "O'Brien's Supply", credit: 12.5 },
  ],
  period: { start: '2026-08-01', end: '2026-08-31' },
};

describe('writeParquet', () => {
  it('writes typed Parquet to a path containing an apostrophe', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'kb-pq-')), "GL's", 'aug.parquet');
    await writeParquet(TABLE, out);
    const c = await duck();
    const r = await c.runAndReadAll(`SELECT typeof(post_date) t, round(sum(credit), 2) s, count(*) n FROM read_parquet(${sqlStr(out)}) GROUP BY 1`);
    expect(r.getRowObjectsJson()).toEqual([{ t: 'DATE', s: 67.48, n: '2' }]);
  });
});

describe('describeSheet / sheetRowSections', () => {
  it('describes columns, row count, date range and samples', () => {
    const d = describeSheet({ file: '08.2026 General_Ledger_Activity_Detail.xlsx', sheet: 'Sheet1', context: "Hilton Palm Beach PBI › Accounting › GL's › Aug 2026", table: TABLE });
    expect(d).toContain('Spreadsheet "08.2026 General_Ledger_Activity_Detail.xlsx", sheet "Sheet1"');
    expect(d).toContain('2 rows');
    expect(d).toContain('Columns: post_date (date), reference (text), credit (number)');
    expect(d).toContain('Dates from 2026-08-01 to 2026-08-03');
    expect(d).toContain('reference: Manual (Non-Check) Amazon');
  });

  it('turns small sheets into row text and skips big ones', () => {
    const s = sheetRowSections(TABLE, 'Sheet1');
    expect(s).toHaveLength(1);
    expect(s[0].heading).toBe('Sheet1 rows 1-2');
    expect(s[0].text).toBe("post_date: 2026-08-01; reference: Manual (Non-Check) Amazon; credit: 54.98\npost_date: 2026-08-03; reference: O'Brien's Supply; credit: 12.5");
    expect(sheetRowSections(TABLE, 'Sheet1', 1)).toEqual([]);
  });
});
