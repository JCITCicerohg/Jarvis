import type { Cell } from './types.ts';

/** Turns an exceljs cell value (formula, rich text, hyperlink, Date, error) into a plain value. */
export function cellValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string') { const t = v.trim(); return t ? t : null; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return null;
    if ('result' in o) return cellValue(o.result);
    if (Array.isArray(o.richText)) return cellValue((o.richText as { text?: string }[]).map(r => r.text ?? '').join(''));
    if ('text' in o) return cellValue(o.text);
  }
  return null;
}

/** "1,632.98" → 1632.98, "$1,200" → 1200, "(12.50)" → -12.5, "45%" → 45; anything else → null. */
export function toNumber(v: Cell): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = /^(\()?\s*(-)?\$?\s*([\d,]*\.?\d+)\s*(\))?%?$/.exec(v.trim());
  if (!m || (m[1] && !m[4])) return null;
  const n = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] || m[2] ? -n : n;
}

/** "8/1/2026" or "2026-08-01" → "2026-08-01"; anything else → null. */
export function toIsoDate(v: Cell): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let y: number, m: number, d: number;
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (a) [y, m, d] = [Number(a[1]), Number(a[2]), Number(a[3])];
  else if (b) [y, m, d] = [Number(b[3]), Number(b[1]), Number(b[2])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** RFC 4180 CSV: quoted fields may contain commas, doubled quotes and newlines. */
export function parseCsv(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [], field = '', quoted = false;
  const push = () => { row.push(field.trim() ? field : null); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      push(); rows.push(row); row = [];
    } else field += ch;
  }
  if (field || row.length) { push(); rows.push(row); }
  return rows.filter(r => r.some(c => c !== null));
}
