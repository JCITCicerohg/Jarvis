export type FilterField = 'hotel' | 'department' | 'dataset' | 'file_type';
export type Filter =
  | { and: Filter[] } | { or: Filter[] } | { not: Filter }
  | { field: FilterField; eq: string }
  | { field: 'period'; from: string; to: string };

const COLUMNS: Record<FilterField, string> = { hotel: 'hotel', department: 'department', dataset: 'dataset', file_type: 'file_type' };

/** Compiles a filter tree to SQL over `alias`; every value is a bound parameter appended to `params`. */
export function compileFilter(f: Filter, params: unknown[], alias: string): string {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if ('and' in f) return f.and.length ? `(${f.and.map(x => compileFilter(x, params, alias)).join(' AND ')})` : 'TRUE';
  if ('or' in f) return f.or.length ? `(${f.or.map(x => compileFilter(x, params, alias)).join(' OR ')})` : 'TRUE';
  if ('not' in f) return `NOT (${compileFilter(f.not, params, alias)})`;
  if (f.field === 'period') {
    const from = p(f.from), to = p(f.to);
    return `(${alias}.period_start <= ${to}::date AND coalesce(${alias}.period_end, ${alias}.period_start) >= ${from}::date)`;
  }
  const col = COLUMNS[f.field];
  if (!col) throw new Error(`unknown filter field ${String((f as { field: unknown }).field)}`);
  return `lower(${alias}.${col}) = lower(${p(f.eq)})`;
}
