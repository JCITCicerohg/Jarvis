import type { Db } from '../db/pool.ts';
import type { Embedder } from '../embed/embedder.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { BlobStore } from '../store/blob.ts';
import { loadCatalog } from './catalog.ts';
import { runMeasure } from './numeric.ts';
import type { QueryPlan } from './plan.ts';
import { planQuestion, type Planner } from './planner.ts';
import { monthsBetween, validatePlan } from './validate.ts';

export interface QueryDeps { db: Db; gen: number; embedder: Embedder; blob: BlobStore; planner: Planner }
type Row = Record<string, string | number | null>;
export interface QueryResult {
  plan: QueryPlan;
  answer_data?: Row[];
  passages?: { text: string; heading: string | null; file: string; page: number | null; link: string | null; period: string | null; score: number }[];
  files?: { file: string; link: string | null; period: string | null; summary: string }[];
  sources?: { file: string; link: string | null; period: string }[];
  coverage: { requested?: string[]; missing: string[] };
  notes: string[];
  confidence: 'high' | 'medium' | 'low';
  generation: number;
}

const LOWER = { high: 'medium', medium: 'low', low: 'low' } as const;

export function trimResult(r: QueryResult, budgetTokens = 3000): QueryResult {
  const out: QueryResult = { ...r, notes: [...r.notes] };
  if (out.passages) out.passages = out.passages.map(p => ({ ...p, text: p.text.length > 1500 ? p.text.slice(0, 1497) + '…' : p.text }));
  const size = () => JSON.stringify(out).length / 4;
  let dropped = false;
  while (size() > budgetTokens && (out.passages?.length ?? 0) > 1) { out.passages!.pop(); dropped = true; }
  while (size() > budgetTokens && (out.files?.length ?? 0) > 1) { out.files!.pop(); dropped = true; }
  if (dropped) out.notes.push('Some lower-ranked passages were left out to keep the answer short.');
  return out;
}

export async function runQuery(d: QueryDeps, question: string, today = new Date().toISOString().slice(0, 10), user: string | null = null): Promise<QueryResult> {
  const started = Date.now();
  const catalog = await loadCatalog(d.db, d.gen);
  const planned = await planQuestion(d.planner, question, catalog, today);
  const { plan, notes } = validatePlan(planned.raw, catalog);
  notes.unshift(...planned.notes);
  const result: QueryResult = { plan, coverage: { missing: [] }, notes, confidence: 'low', generation: d.gen };

  if (plan.measure) {
    const m = await runMeasure(d, plan);
    result.answer_data = m.rows;
    result.sources = m.sources;
    const requested = [...new Set(plan.periods.flatMap(p => monthsBetween(p.from, p.to)))].sort();
    if (requested.length) {
      result.coverage = { requested, missing: requested.filter(x => !m.presentMonths.includes(x)) };
    }
    result.confidence = !m.rows.length ? 'low' : result.coverage.missing.length ? 'medium' : 'high';
    if (!m.rows.length) notes.push('No matching rows were found in the spreadsheet data for that question.');
  } else {
    const passages = await hybridSearch(d, { filter: plan.filter, keywords: plan.keywords, semantic: plan.semantic.join(' ; ') || question, k: plan.intent === 'find_files' ? 30 : 8 });
    if (plan.intent === 'find_files') {
      const byDoc = new Map<number, (typeof passages)[number]>();
      for (const p of passages) if (!byDoc.has(p.documentId)) byDoc.set(p.documentId, p);
      result.files = [...byDoc.values()].map(p => ({ file: p.file, link: p.link, period: p.period, summary: p.text.replace(/\s+/g, ' ').slice(0, 300) }));
    } else {
      result.passages = passages.map(({ text, heading, file, page, link, period, score }) => ({ text, heading, file, page, link, period, score: Math.round(score * 10000) / 10000 }));
    }
    const n = passages.length;
    result.confidence = n >= 3 ? 'high' : n >= 1 ? 'medium' : 'low';
  }
  if (notes.length && result.confidence !== 'low') result.confidence = LOWER[result.confidence];

  const trimmed = trimResult(result);
  await d.db.query(
    `INSERT INTO kb_meta.query_log (user_name, question, plan, generation, latency_ms, passages, rows, confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [user, question, JSON.stringify(plan), d.gen, Date.now() - started, trimmed.passages?.length ?? trimmed.files?.length ?? 0, trimmed.answer_data?.length ?? 0, trimmed.confidence],
  );
  return trimmed;
}
