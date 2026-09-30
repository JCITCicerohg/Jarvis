import { duck, sqlStr } from '../duck.ts';
import { gschema } from '../db/migrate.ts';
import type { Db } from '../db/pool.ts';
import type { BlobStore } from '../store/blob.ts';
import type { Column } from '../sheets/types.ts';
import { compileFilter } from './filter.ts';
import type { QueryPlan } from './plan.ts';
import { monthsBetween } from './validate.ts';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const AGG = { sum: 'sum', avg: 'avg', count: 'count', min: 'min', max: 'max' } as const;

/** Runs the plan's measure over the matching tidy Parquet files with a fixed SQL template. */
export async function runMeasure(d: { db: Db; gen: number; blob: BlobStore }, plan: QueryPlan) {
  const m = plan.measure!;
  const s = gschema(d.gen);
  const params: unknown[] = [m.dataset];
  const where = compileFilter(plan.filter, params, 'x');
  const files = (await d.db.query(
    `SELECT x.blob_key, x.columns, x.period_start, x.period_end, doc.name, doc.web_url
     FROM ${s}.datasets x JOIN ${s}.documents doc ON doc.id = x.document_id
     WHERE lower(x.dataset) = lower($1) AND ${where} ORDER BY x.period_start`, params)).rows;
  if (!files.length) return { rows: [], sources: [], presentMonths: [] };

  const columns = files[0].columns as Column[];
  const dateCol = columns.find(c => c.type === 'date')?.name;
  const paths = await Promise.all(files.map(f => d.blob.localPath(f.blob_key)));
  const binds: string[] = [];
  const conds: string[] = [];
  if (dateCol && plan.periods.length) {
    conds.push('(' + plan.periods.map(p => { binds.push(p.from, p.to); return `${ident(dateCol)} BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)`; }).join(' OR ') + ')');
  }
  for (const w of m.whereText) { binds.push(w.contains); conds.push(`${ident(w.column)} ILIKE '%' || ? || '%'`); }
  const group = m.groupBy && dateCol
    ? { year: `CAST(year(${ident(dateCol)}) AS INTEGER)`, month: `strftime(${ident(dateCol)}, '%Y-%m')`, day: `CAST(${ident(dateCol)} AS VARCHAR)` }[m.groupBy]
    : null;
  const value = m.agg === 'count' ? 'count(*)' : `${AGG[m.agg]}(${ident(m.field)})`;
  const sql = `SELECT ${group ? `${group} AS g, ` : ''}${value} AS value, count(*) AS rows
    FROM read_parquet([${paths.map(sqlStr).join(', ')}], union_by_name = true)
    ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ${group ? 'GROUP BY 1 ORDER BY 1' : ''}`;

  const c = await duck();
  const stmt = await c.prepare(sql);
  binds.forEach((b, i) => stmt.bindVarchar(i + 1, b));
  const out = (await stmt.runAndReadAll()).getRowObjectsJson() as Record<string, unknown>[];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const rows = out
    .filter(r => Number(r.rows) > 0)
    .map(r => ({ ...(group ? { [m.groupBy!]: m.groupBy === 'year' ? Number(r.g) : String(r.g) } : {}), value: num(r.value) === null ? null : Math.round(num(r.value)! * 100) / 100, rows: Number(r.rows) }));
  const presentMonths = [...new Set(files.flatMap(f => monthsBetween(f.period_start, f.period_end)))];
  const sources = files.map(f => ({ file: f.name as string, link: f.web_url as string | null, period: f.period_start === f.period_end ? f.period_start : `${f.period_start} to ${f.period_end}` }));
  return { rows, sources, presentMonths };
}
