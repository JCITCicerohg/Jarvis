import ExcelJS from 'exceljs';
import { cellValue, parseCsv } from './cells.ts';
import type { Cell, Parsed, SheetData } from './types.ts';

/** Trims trailing empty cells per row and drops trailing empty rows. */
function tidy(rows: Cell[][]): Cell[][] {
  const out = rows.map(r => { const c = [...r]; while (c.length && c[c.length - 1] === null) c.pop(); return c; });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

export async function parseXlsx(bytes: Buffer): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheets: SheetData[] = [];
  for (const ws of wb.worksheets) {
    const rows: Cell[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellValue(row.getCell(c).value));
      rows.push(cells);
    }
    const t = tidy(rows);
    if (t.some(r => r.length)) sheets.push({ name: ws.name, rows: t });
  }
  return { kind: 'sheets', sheets };
}

export function parseCsvFile(name: string, bytes: Buffer): Parsed {
  return { kind: 'sheets', sheets: [{ name: name.replace(/\.[^.]+$/, ''), rows: tidy(parseCsv(bytes.toString('utf8').replace(/^﻿/, ''))) }] };
}
