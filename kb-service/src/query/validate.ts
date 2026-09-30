import type { Catalog } from './catalog.ts';
import type { Filter, FilterField } from './filter.ts';
import type { PlannerOutputT, QueryPlan } from './plan.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function edge(s: string, end: boolean): string | null {
  const t = s.trim();
  let m = /^(\d{4})$/.exec(t);
  if (m) return end ? `${m[1]}-12-31` : `${m[1]}-01-01`;
  m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-${pad(end ? lastDay(Number(m[1]), Number(m[2])) : 1)}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) { const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))); return d.getUTCDate() === Number(m[3]) ? t : null; }
  return null;
}

export function normalizeRange(from: string, to: string): { from: string; to: string } | null {
  const a = edge(from, false), b = edge(to, true);
  if (!a || !b) return null;
  return a <= b ? { from: a, to: b } : { from: edge(to, false)!, to: edge(from, true)! };
}

export function monthsBetween(from: string, to: string, cap = 60): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  while (out.length < cap) {
    const k = `${y}-${pad(m)}`;
    out.push(k);
    if (k >= end) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

const LISTS: Record<FilterField, (c: Catalog) => string[]> = {
  hotel: c => c.hotels, department: c => c.departments, dataset: c => c.datasets.map(d => d.name), file_type: c => c.fileTypes,
};
const canonical = (c: Catalog, field: FilterField, v: string) => LISTS[field](c).find(x => x.toLowerCase() === v.trim().toLowerCase()) ?? null;

/** Checks every value against the catalog, makes periods exact, and builds the boolean filter tree. */
export function validatePlan(raw: PlannerOutputT, catalog: Catalog): { plan: QueryPlan; notes: string[] } {
  const notes: string[] = [];
  const and: Filter[] = [];
  for (const c of raw.all) {
    const v = canonical(catalog, c.field, c.value);
    if (v) and.push({ field: c.field, eq: v });
    else notes.push(`No ${c.field.replace('_', ' ')} called "${c.value}" in the knowledge base; searched without that filter.`);
  }
  const periods: { from: string; to: string }[] = [];
  for (const p of raw.any_of_periods) {
    const r = normalizeRange(p.from, p.to);
    if (r) periods.push(r); else notes.push(`Could not read the period "${p.from}" to "${p.to}"; searched all dates.`);
  }
  if (periods.length) and.push({ or: periods.map(p => ({ field: 'period' as const, ...p })) });
  const excl: Filter[] = [];
  for (const c of raw.exclude) {
    const v = canonical(catalog, c.field, c.value);
    if (v) excl.push({ field: c.field, eq: v });
    else notes.push(`No ${c.field.replace('_', ' ')} called "${c.value}" in the knowledge base; ignored that exclusion.`);
  }
  if (excl.length) and.push({ not: { or: excl } });

  let measure: QueryPlan['measure'] = null;
  let intent = raw.intent, answer_shape = raw.answer_shape;
  if (raw.measure) {
    const ds = catalog.datasets.find(d => d.name.toLowerCase() === raw.measure!.dataset.toLowerCase());
    const col = (n: string) => ds?.columns?.find(c => c.name === n);
    if (!ds?.columns) notes.push(`No spreadsheet data for "${raw.measure.dataset}", so nothing could be calculated; showing matching documents instead.`);
    else if (raw.measure.agg !== 'count' && col(raw.measure.field)?.type !== 'number') notes.push(`"${raw.measure.field}" is not a number column in ${ds.name}; showing matching documents instead.`);
    else {
      const whereText = raw.measure.where_text.filter(w => col(w.column)?.type === 'text' && w.contains.trim());
      if (whereText.length < raw.measure.where_text.length) notes.push('Some text conditions named columns that do not exist and were ignored.');
      measure = { dataset: ds.name, agg: raw.measure.agg, field: raw.measure.field, whereText, groupBy: raw.measure.group_by[0] ?? null };
    }
    if (!measure) { intent = 'doc_question'; answer_shape = 'answer+quotes'; }
  }
  const semantic = raw.semantic.map(s => s.trim()).filter(Boolean);
  return {
    plan: { intent, filter: { and }, periods, keywords: raw.keywords, semantic, measure, answer_shape },
    notes,
  };
}
