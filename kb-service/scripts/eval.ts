import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { createEmbedder, createPlanner } from '../src/llm/factory.ts';
import { runQuery, type QueryResult } from '../src/query/executor.ts';
import { LocalBlobStore } from '../src/store/blob.ts';

export interface EvalRow { question: string; expected_files: string[]; expected_value?: number }

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
  return { questions: rows.length, hit_at_5: hits / rows.length, mrr: rr / rows.length, numeric_accuracy: numTotal ? numOk / numTotal : null };
}

if (process.argv[1]?.endsWith('eval.ts')) {
  const rows = readFileSync('eval/questions.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as EvalRow);
  if (process.argv.includes('--dry')) {
    const fake = rows.map(r => ({ plan: {} as never, coverage: { missing: [] }, notes: [], confidence: 'high' as const, generation: 1, files: r.expected_files.map(file => ({ file, link: null, period: null, summary: '' })) }));
    console.log(scoreEval(rows, fake));
  } else {
    const env = loadEnv();
    const db = createPool(env.databaseUrl);
    const embedder = createEmbedder(env);
    const gen = await migrate(db, embedder.model, embedder.dim);
    const deps = { db, gen, embedder, blob: new LocalBlobStore(env.blobDir), planner: createPlanner(env) };
    const results: QueryResult[] = [];
    for (const r of rows) results.push(await runQuery(deps, r.question));
    const score = scoreEval(rows, results);
    console.log(score);
    rows.forEach((r, i) => console.log(`${results[i].confidence.padEnd(6)} ${r.question}`));
    await db.end();
    if (score.hit_at_5 < 0.85) process.exitCode = 1;
  }
}
