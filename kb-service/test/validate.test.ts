import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/query/catalog.ts';
import { PlannerOutput, type PlannerOutputT } from '../src/query/plan.ts';
import { monthsBetween, normalizeRange, validatePlan } from '../src/query/validate.ts';

const CATALOG: Catalog = {
  hotels: ['Hilton Palm Beach PBI'], departments: ['Accounting', 'Guest Scores'], fileTypes: ['xlsx', 'pdf'],
  datasets: [
    { name: "GL's", department: 'Accounting', from: '2024-01-01', to: '2026-08-31', files: 32, columns: [
      { name: 'post_date', type: 'date' }, { name: 'reference', type: 'text' }, { name: 'credit', type: 'number' }, { name: 'debit', type: 'number' },
    ] },
    { name: 'Stay Experience', department: 'Guest Scores', from: '2024-01-01', to: '2026-08-31', files: 30, columns: null },
  ],
};

const base = (over: Partial<PlannerOutputT> = {}): PlannerOutputT => ({
  intent: 'doc_question', all: [], any_of_periods: [], exclude: [], keywords: { must: [], should: [], not: [] },
  semantic: ['q'], measure: null, answer_shape: 'answer+quotes', ...over,
});

describe('normalizeRange / monthsBetween', () => {
  it('expands months and years, swaps reversed ranges, rejects junk', () => {
    expect(normalizeRange('2026-01', '2026-08')).toEqual({ from: '2026-01-01', to: '2026-08-31' });
    expect(normalizeRange('2025', '2025')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(normalizeRange('2026-03-31', '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(normalizeRange('last month', '2026-01')).toBeNull();
    expect(monthsBetween('2025-11-01', '2026-02-28')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('validatePlan', () => {
  it('builds the boolean filter tree with canonical names', () => {
    const { plan, notes } = validatePlan(base({
      intent: 'numeric_compare',
      all: [{ field: 'hotel', value: 'hilton palm beach pbi' }, { field: 'dataset', value: "gl's" }],
      any_of_periods: [{ from: '2026-01', to: '2026-08' }, { from: '2025-01', to: '2025-08' }],
      measure: { dataset: "GL's", agg: 'sum', field: 'credit', where_text: [{ column: 'reference', contains: 'Amazon' }], group_by: ['year'] },
      answer_shape: 'headline+table',
    }), CATALOG);
    expect(notes).toEqual([]);
    expect(plan.filter).toEqual({ and: [
      { field: 'hotel', eq: 'Hilton Palm Beach PBI' }, { field: 'dataset', eq: "GL's" },
      { or: [{ field: 'period', from: '2026-01-01', to: '2026-08-31' }, { field: 'period', from: '2025-01-01', to: '2025-08-31' }] },
    ] });
    expect(plan.measure).toEqual({ dataset: "GL's", agg: 'sum', field: 'credit', whereText: [{ column: 'reference', contains: 'Amazon' }], groupBy: 'year' });
  });

  it('drops values that do not exist and says so', () => {
    const { plan, notes } = validatePlan(base({
      all: [{ field: 'hotel', value: 'Marriott Miami' }, { field: 'department', value: 'Accounting' }],
      any_of_periods: [{ from: 'soon', to: 'later' }],
      exclude: [{ field: 'dataset', value: 'Nope' }],
    }), CATALOG);
    expect(plan.filter).toEqual({ and: [{ field: 'department', eq: 'Accounting' }] });
    expect(notes).toEqual([
      'No hotel called "Marriott Miami" in the knowledge base; searched without that filter.',
      'Could not read the period "soon" to "later"; searched all dates.',
      'No dataset called "Nope" in the knowledge base; ignored that exclusion.',
    ]);
  });

  it('drops a measure on an unknown dataset or non-numeric field and falls back to a document question', () => {
    const bad = validatePlan(base({ intent: 'numeric', measure: { dataset: "GL's", agg: 'sum', field: 'reference', where_text: [], group_by: [] } }), CATALOG);
    expect(bad.plan).toMatchObject({ intent: 'doc_question', measure: null, answer_shape: 'answer+quotes' });
    expect(bad.notes[0]).toMatch(/"reference" is not a number column/);
    const missing = validatePlan(base({ intent: 'numeric', measure: { dataset: 'Payroll', agg: 'sum', field: 'x', where_text: [], group_by: [] } }), CATALOG);
    expect(missing.notes[0]).toMatch(/No spreadsheet data for "Payroll"/);
  });

  it('accepts the zod schema shape', () => {
    expect(PlannerOutput.safeParse(base()).success).toBe(true);
    expect(PlannerOutput.safeParse({ ...base(), intent: 'weather' }).success).toBe(false);
  });
});
