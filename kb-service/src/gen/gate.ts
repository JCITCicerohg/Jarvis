import { gschema } from '../db/migrate.ts';
import type { Db } from '../db/pool.ts';
import { scoreEval, type EvalRow } from '../eval/score.ts';
import { runQuery, type QueryDeps, type QueryResult } from '../query/executor.ts';

export const GATE_HIT5 = 0.85;

export async function evaluate(qd: QueryDeps, rows: EvalRow[], today?: string): Promise<{ hit5: number; mrr: number }> {
  const results: QueryResult[] = [];
  for (const r of rows) results.push(await runQuery(qd, r.question, today, 'eval'));
  const s = scoreEval(rows, results);
  return { hit5: s.hit_at_5, mrr: s.mrr };
}

export async function errorCount(db: Db, gen: number): Promise<number> {
  return Number((await db.query(`SELECT count(*)::int AS n FROM ${gschema(gen)}.documents WHERE status = 'error'`)).rows[0].n);
}

export interface GateInput {
  candidate: { build_done: number; build_total: number; errors: number; hit5: number };
  live: { errors: number; hit5: number };
  questions: number;
}

export function gateVerdict(g: GateInput): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const f = (x: number) => x.toFixed(2);
  if (g.candidate.build_done < g.candidate.build_total) reasons.push(`Build is not finished (${g.candidate.build_done} of ${g.candidate.build_total} files).`);
  if (g.candidate.errors > g.live.errors) reasons.push(`More files failed than in the live generation (${g.candidate.errors} vs ${g.live.errors}).`);
  if (!g.questions) reasons.push('No eval questions configured (eval/questions.jsonl).');
  else {
    if (g.candidate.hit5 < GATE_HIT5) reasons.push(`Eval hit@5 ${f(g.candidate.hit5)} is below ${GATE_HIT5}.`);
    if (g.candidate.hit5 < g.live.hit5) reasons.push(`Eval hit@5 ${f(g.candidate.hit5)} is below the live generation (${f(g.live.hit5)}).`);
  }
  return { ready: reasons.length === 0, reasons };
}
