import type { TextSection } from '../parse/types.ts';
import type { TidyTable } from './types.ts';

const rowText = (t: TidyTable, r: Record<string, unknown>) =>
  t.columns.filter(c => r[c.name] !== null && r[c.name] !== undefined).map(c => `${c.name}: ${r[c.name]}`).join('; ');

/** One searchable description per sheet, so search can find the right dataset. */
export function describeSheet(p: { file: string; sheet: string; context: string; table: TidyTable }): string {
  const { table } = p;
  const dateCol = table.columns.find(c => c.type === 'date');
  const dates = dateCol ? table.rows.map(r => r[dateCol.name]).filter((d): d is string => typeof d === 'string').sort() : [];
  return [
    `Spreadsheet "${p.file}", sheet "${p.sheet}" (${p.context}).`,
    `${table.rows.length} rows. Columns: ${table.columns.map(c => `${c.name} (${c.type})`).join(', ')}.`,
    dates.length ? `Dates from ${dates[0]} to ${dates[dates.length - 1]}.` : '',
    'Sample rows:',
    ...table.rows.slice(0, 5).map(r => '- ' + rowText(table, r)),
  ].filter(Boolean).join('\n');
}

/** Small sheets (trackers) are also searchable row by row, 25 rows per section. */
export function sheetRowSections(table: TidyTable, sheet: string, maxRows = 200): TextSection[] {
  if (table.rows.length > maxRows) return [];
  const out: TextSection[] = [];
  for (let i = 0; i < table.rows.length; i += 25) {
    const part = table.rows.slice(i, i + 25);
    out.push({ heading: `${sheet} rows ${i + 1}-${i + part.length}`, page: null, text: part.map(r => rowText(table, r)).join('\n') });
  }
  return out;
}
