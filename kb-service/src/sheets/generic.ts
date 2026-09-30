import { toIsoDate, toNumber } from '../parse/cells.ts';
import type { Cell } from '../parse/types.ts';
import type { Column, TidyTable, Value } from './types.ts';

const filled = (c: Cell) => c !== null && c !== '';

export const snake = (s: string) => s.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** First row (within 30) with ≥ 2 filled cells, ≥ 60% of them text, followed by a row with data. */
export function detectHeaderRow(rows: Cell[][]): number {
  for (let i = 0; i < Math.min(rows.length - 1, 30); i++) {
    const cells = (rows[i] ?? []).filter(filled);
    if (cells.length < 2) continue;
    const text = cells.filter(c => typeof c === 'string' && toNumber(c) === null && toIsoDate(c) === null).length;
    const hasData = rows.slice(i + 1, i + 4).some(r => (r ?? []).filter(filled).length >= 2);
    if (text / cells.length >= 0.6 && hasData) return i;
  }
  return -1;
}

function inferType(values: Cell[]): Column['type'] {
  const v = values.filter(filled);
  if (!v.length) return 'text';
  if (v.every(x => toNumber(x) !== null)) return 'number';
  if (v.every(x => toIsoDate(x) !== null)) return 'date';
  return 'text';
}

function convert(c: Cell, type: Column['type']): Value {
  if (!filled(c)) return null;
  if (type === 'number') return toNumber(c);
  if (type === 'date') return toIsoDate(c);
  return String(c);
}

export function genericNormalize(rows: Cell[][]): TidyTable | null {
  const h = detectHeaderRow(rows);
  if (h < 0) return null;
  const data = rows.slice(h + 1).filter(r => r.some(filled));
  const width = Math.max(rows[h].length, ...data.map(r => r.length));
  const keep = Array.from({ length: width }, (_, i) => i).filter(i => filled(rows[h][i] ?? null) || data.some(r => filled(r[i] ?? null)));
  const seen = new Map<string, number>();
  const columns: Column[] = keep.map(i => {
    let name = snake(String(rows[h][i] ?? '')) || `col_${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}_${n}`;
    return { name, type: inferType(data.map(r => r[i] ?? null)) };
  });
  const out = data.map(r => Object.fromEntries(keep.map((i, k) => [columns[k].name, convert(r[i] ?? null, columns[k].type)])));
  return { columns, rows: out };
}
