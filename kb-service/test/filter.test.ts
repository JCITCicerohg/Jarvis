import { describe, expect, it } from 'vitest';
import { compileFilter, type Filter } from '../src/query/filter.ts';

describe('compileFilter', () => {
  it('compiles and/or/not with bound parameters', () => {
    const f: Filter = { and: [
      { field: 'hotel', eq: 'Hilton Palm Beach PBI' },
      { or: [{ field: 'period', from: '2026-01-01', to: '2026-08-31' }, { field: 'period', from: '2025-01-01', to: '2025-08-31' }] },
      { not: { field: 'dataset', eq: "GL's" } },
    ] };
    const params: unknown[] = [];
    expect(compileFilter(f, params, 'c')).toBe(
      "(lower(c.hotel) = lower($1) AND ((c.period_start <= $3::date AND coalesce(c.period_end, c.period_start) >= $2::date) OR (c.period_start <= $5::date AND coalesce(c.period_end, c.period_start) >= $4::date)) AND NOT (lower(c.dataset) = lower($6)))",
    );
    expect(params).toEqual(['Hilton Palm Beach PBI', '2026-01-01', '2026-08-31', '2025-01-01', '2025-08-31', "GL's"]);
  });

  it('treats empty groups as no constraint and never interpolates values', () => {
    const params: unknown[] = [];
    expect(compileFilter({ and: [{ or: [] }] }, params, 'c')).toBe('(TRUE)');
    const sql = compileFilter({ field: 'hotel', eq: "x'); DROP TABLE documents; --" }, params, 'c');
    expect(sql).toBe('lower(c.hotel) = lower($1)');
    expect(params).toEqual(["x'); DROP TABLE documents; --"]);
  });

  it('rejects unknown fields', () => {
    expect(() => compileFilter({ field: 'owner' as never, eq: 'x' }, [], 'c')).toThrow(/unknown filter field/);
  });
});
