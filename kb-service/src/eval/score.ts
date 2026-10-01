import { readFileSync } from 'node:fs';
import type { QueryResult } from '../query/executor.ts';

export interface EvalRow { question: string; expected_files: string[]; expected_value?: number }

export function loadEvalRows(path: string): EvalRow[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as EvalRow);
}

/** hit@5, MRR over the first 5 cited files, and numeric accuracy (±0.5%) where an expected value is given. */
export function scoreEval(rows: EvalRow[], results: QueryResult[]) {
  let hits = 0, rr = 0, numTotal = 0, numOk = 0;
  rows.forEach((row, i) => {
    const r = results[i];
    const cited = [...(r.passages ?? []).map(p => p.file), ...(r.files ?? []).map(f => f.file), ...(r.sources ?? []).map(s => s.file)].filter((f, j, a) => a.indexOf(f) === j).slice(0, 5);
    const rank = cited.findIndex(f => row.expected_files.includes(f));
    if (rank >= 0) { hits++; rr += 1 / (rank + 1); }
    if (row.expected_value !== undefined) {
      numTotal++;
      const got = r.answer_data?.reduce((s, x) => s + (typeof x.value === 'number' ? x.value : 0), 0);
      if (got !== undefined && Math.abs(got - row.expected_value) <= Math.abs(row.expected_value) * 0.005) numOk++;
    }
  });
  const n = rows.length || 1;
  return { questions: rows.length, hit_at_5: hits / n, mrr: rr / n, numeric_accuracy: numTotal ? numOk / numTotal : null };
}
