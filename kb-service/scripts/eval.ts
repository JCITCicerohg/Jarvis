import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { createEmbedder, createPlanner } from '../src/llm/factory.ts';
import { runQuery, type QueryResult } from '../src/query/executor.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { scoreEval, type EvalRow } from '../src/eval/score.ts';
export { scoreEval, type EvalRow };

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
