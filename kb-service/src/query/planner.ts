import type { JsonModel } from '../llm/json-model.ts';
import type { Catalog } from './catalog.ts';
import { PlannerOutput, type PlannerOutputT } from './plan.ts';

export interface Planner { plan(question: string, catalog: Catalog, today: string): Promise<PlannerOutputT> }

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const cond = obj({ field: { type: 'string', enum: ['hotel', 'department', 'dataset', 'file_type'] }, value: str });

/** PlannerOutput as a strict JSON schema (every key required, nulls explicit), accepted by Anthropic, OpenAI and Azure. */
export const PLANNER_JSON_SCHEMA = obj({
  intent: { type: 'string', enum: ['doc_question', 'find_files', 'numeric', 'numeric_compare', 'trend'] },
  all: { type: 'array', items: cond },
  any_of_periods: { type: 'array', items: obj({ from: str, to: str }) },
  exclude: { type: 'array', items: cond },
  keywords: obj({ must: strs, should: strs, not: strs }),
  semantic: strs,
  measure: {
    anyOf: [{ type: 'null' }, obj({
      dataset: str, agg: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'] }, field: str,
      where_text: { type: 'array', items: obj({ column: str, contains: str }) },
      group_by: { type: 'array', items: { type: 'string', enum: ['year', 'month', 'day'] } },
    })],
  },
  answer_shape: { type: 'string', enum: ['headline+table', 'table', 'answer+quotes', 'file_list'] },
});

export const PLANNER_SYSTEM = `You turn a hotel executive's question into a search plan for a knowledge base of their company files (SharePoint documents and spreadsheets). You never answer the question yourself.

How to fill the plan:
- intent: doc_question (answer from document text), find_files (which files cover something), numeric (one calculated figure), numeric_compare (the same figure for two or more periods), trend (a figure period by period).
- all: filters that must all hold. Use only values that appear in the catalog, spelled as the catalog spells them. Leave a filter out rather than guess.
- any_of_periods: the date ranges asked about, as YYYY, YYYY-MM or YYYY-MM-DD. Resolve relative dates ("last month", "Q3", "YTD", "this year vs last year") from Today. Use two ranges for a comparison. Leave empty when no dates are implied.
- exclude: filters to rule out, only when the user says so.
- keywords.must: exact names or terms that must appear (vendors, people, account names). keywords.should: helpful extra terms. keywords.not: terms to exclude.
- semantic: 1 to 3 short rewrites of the question for meaning-based search.
- measure: only for numeric, numeric_compare and trend, and only when a catalog dataset has columns. dataset = that dataset's name; field = a number column; agg = sum, avg, count, min or max; where_text = text-column conditions, e.g. {"column": "reference", "contains": "Amazon"}; group_by = ["year"] for year comparisons, ["month"] for monthly trends, [] for one total. Otherwise null.
- answer_shape: headline+table for numbers, table for trends, answer+quotes for document questions, file_list for find_files.`;

export class ModelPlanner implements Planner {
  constructor(private model: JsonModel) {}
  async plan(question: string, catalog: Catalog, today: string): Promise<PlannerOutputT> {
    const out = await this.model.json(PLANNER_SYSTEM, `Today: ${today}\n\nCatalog:\n${JSON.stringify(catalog)}\n\nQuestion: ${question}`, PLANNER_JSON_SCHEMA);
    const parsed = PlannerOutput.safeParse(out);
    if (!parsed.success) throw new Error('planner returned an invalid plan: ' + parsed.error.message.slice(0, 300));
    return parsed.data;
  }
}

export const fallbackPlan = (question: string): PlannerOutputT => ({
  intent: 'doc_question', all: [], any_of_periods: [], exclude: [], keywords: { must: [], should: [], not: [] },
  semantic: [question], measure: null, answer_shape: 'answer+quotes',
});

export async function planQuestion(planner: Planner, question: string, catalog: Catalog, today: string): Promise<{ raw: PlannerOutputT; notes: string[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return { raw: await planner.plan(question, catalog, today), notes: [] }; }
    catch (e) { console.warn(`planner attempt ${attempt + 1} failed:`, (e as Error).message); }
  }
  return { raw: fallbackPlan(question), notes: ['The question planner was unavailable, so this is a plain search with no filters.'] };
}
