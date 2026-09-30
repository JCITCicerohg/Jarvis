import { toIsoDate, toNumber } from '../parse/cells.ts';
import type { Cell } from '../parse/types.ts';
import type { Column, TidyTable, Value } from './types.ts';

const HEADERS: Record<string, string> = {
  'post date': 'post_date', invoice: 'invoice', reference: 'reference', 'detail description': 'detail_description',
  debit: 'debit', credit: 'credit', jeid: 'jeid', 'invoice no': 'invoice_no', source: 'source',
};
const COLUMNS: Column[] = [
  { name: 'account', type: 'text' }, { name: 'account_name', type: 'text' }, { name: 'post_date', type: 'date' },
  { name: 'invoice', type: 'text' }, { name: 'reference', type: 'text' }, { name: 'detail_description', type: 'text' },
  { name: 'debit', type: 'number' }, { name: 'credit', type: 'number' }, { name: 'jeid', type: 'text' },
  { name: 'invoice_no', type: 'text' }, { name: 'source', type: 'text' },
];
const ACCOUNT = /^\d{4,}\.\d{3}$/;
const norm = (c: Cell) => (typeof c === 'string' ? c.trim().toLowerCase() : '');

const headerRow = (rows: Cell[][]) => rows.slice(0, 15).findIndex(r => r.some(c => norm(c) === 'post date'));

export function isGlActivityDetail(rows: Cell[][]): boolean {
  const top = rows.slice(0, 12).flat().map(norm).join(' ');
  return top.includes('general ledger activity detail') && headerRow(rows) >= 0;
}

export function glActivityDetail(rows: Cell[][]): TidyTable {
  const h = headerRow(rows);
  const col = new Map<string, number>();
  rows[h].forEach((c, i) => { const k = HEADERS[norm(c)]; if (k && !col.has(k)) col.set(k, i); });
  const at = (r: Cell[], k: string) => { const i = col.get(k); return i === undefined ? null : r[i] ?? null; };
  const text = (c: Cell): Value => (c === null || c === '' ? null : String(c).trim());

  const title = rows.slice(0, h).flat().filter((c): c is string => typeof c === 'string').join(' ');
  const range = /From (\d{1,2}\/\d{1,2}\/\d{4}) to (\d{1,2}\/\d{1,2}\/\d{4})/.exec(title);
  const period = range ? { start: toIsoDate(range[1])!, end: toIsoDate(range[2])! } : undefined;

  let account: string | null = null, accountName: string | null = null;
  const out: Record<string, Value>[] = [];
  for (const r of rows.slice(h + 1)) {
    const date = toIsoDate(typeof at(r, 'post_date') === 'string' ? (at(r, 'post_date') as string).trim() : at(r, 'post_date'));
    if (date) {
      out.push({
        account, account_name: accountName, post_date: date,
        invoice: text(at(r, 'invoice')), reference: text(at(r, 'reference')), detail_description: text(at(r, 'detail_description')),
        debit: toNumber(at(r, 'debit')), credit: toNumber(at(r, 'credit')),
        jeid: text(at(r, 'jeid')), invoice_no: text(at(r, 'invoice_no')), source: text(at(r, 'source')),
      });
      continue;
    }
    const idx = r.findIndex(c => typeof c === 'string' && ACCOUNT.test(c.trim()));
    if (idx >= 0 && !r.some(c => typeof c === 'string' && /^total\b/i.test(c.trim()))) {
      account = (r[idx] as string).trim();
      accountName = (r.slice(idx + 1).find(c => typeof c === 'string' && c.trim()) as string | undefined)?.trim() ?? null;
    }
  }
  return { columns: COLUMNS, rows: out, period };
}
