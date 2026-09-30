import { z } from 'zod';
import type { Keywords } from '../search/hybrid.ts';
import type { Filter } from './filter.ts';

const Cond = z.object({ field: z.enum(['hotel', 'department', 'dataset', 'file_type']), value: z.string() });
const Range = z.object({ from: z.string().describe('YYYY, YYYY-MM or YYYY-MM-DD'), to: z.string().describe('YYYY, YYYY-MM or YYYY-MM-DD') });

/** What the planner model returns. Flat on purpose: all = AND, any_of_periods = OR, exclude = NOT. */
export const PlannerOutput = z.object({
  intent: z.enum(['doc_question', 'find_files', 'numeric', 'numeric_compare', 'trend']),
  all: z.array(Cond),
  any_of_periods: z.array(Range),
  exclude: z.array(Cond),
  keywords: z.object({ must: z.array(z.string()), should: z.array(z.string()), not: z.array(z.string()) }),
  semantic: z.array(z.string()),
  measure: z.object({
    dataset: z.string(),
    agg: z.enum(['sum', 'avg', 'count', 'min', 'max']),
    field: z.string(),
    where_text: z.array(z.object({ column: z.string(), contains: z.string() })),
    group_by: z.array(z.enum(['year', 'month', 'day'])),
  }).nullable(),
  answer_shape: z.enum(['headline+table', 'table', 'answer+quotes', 'file_list']),
});
export type PlannerOutputT = z.infer<typeof PlannerOutput>;

export type Intent = PlannerOutputT['intent'];
export interface Measure {
  dataset: string; agg: 'sum' | 'avg' | 'count' | 'min' | 'max'; field: string;
  whereText: { column: string; contains: string }[]; groupBy: 'year' | 'month' | 'day' | null;
}
export interface QueryPlan {
  intent: Intent; filter: Filter; periods: { from: string; to: string }[]; keywords: Keywords;
  semantic: string[]; measure: Measure | null; answer_shape: PlannerOutputT['answer_shape'];
}
