import { gschema } from '../db/migrate.ts';
import { vec, type Db } from '../db/pool.ts';
import type { Embedder } from '../embed/embedder.ts';
import { compileFilter, type Filter } from '../query/filter.ts';

export interface Keywords { must: string[]; should: string[]; not: string[] }
export interface Passage {
  sectionId: number; documentId: number; text: string; heading: string | null; file: string;
  page: number | null; link: string | null; period: string | null; score: number;
}

const CANDIDATES = 40;

/** Reciprocal Rank Fusion over ranked id lists. */
export function rrf(lists: number[][], k = 60): Map<number, number> {
  const s = new Map<number, number>();
  for (const list of lists) list.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)));
  return s;
}

/** AND/OR of plainto_tsquery terms; every term is a bound parameter. */
function tsq(terms: string[], op: '&&' | '||', params: unknown[]): string | null {
  const t = terms.map(x => x.trim()).filter(Boolean);
  if (!t.length) return null;
  return '(' + t.map(x => { params.push(x); return `plainto_tsquery('english', $${params.length})`; }).join(` ${op} `) + ')';
}

export async function hybridSearch(d: { db: Db; gen: number; embedder: Embedder }, input: { filter: Filter; keywords: Keywords; semantic: string; k: number }): Promise<Passage[]> {
  const s = gschema(d.gen);
  const [qv] = await d.embedder.embed([input.semantic]);

  const build = () => {
    const params: unknown[] = [];
    const where = [compileFilter(input.filter, params, 'c')];
    const must = tsq(input.keywords.must, '&&', params);
    const not = tsq(input.keywords.not, '||', params);
    if (must) where.push(`c.tsv @@ ${must}`);
    if (not) where.push(`NOT (c.tsv @@ ${not})`);
    return { params, where: where.join(' AND ') };
  };

  const v = build();
  v.params.push(vec(qv));
  const vRows = (await d.db.query(`SELECT c.id FROM ${s}.chunks c WHERE ${v.where} ORDER BY c.embedding <=> $${v.params.length}::vector LIMIT ${CANDIDATES}`, v.params)).rows;

  const t = build();
  const rank = tsq([...input.keywords.must, ...input.keywords.should], '||', t.params) ?? (() => { t.params.push(input.semantic); return `websearch_to_tsquery('english', $${t.params.length})`; })();
  const tRows = (await d.db.query(`SELECT c.id FROM ${s}.chunks c WHERE ${t.where} AND c.tsv @@ ${rank} ORDER BY ts_rank_cd(c.tsv, ${rank}) DESC LIMIT ${CANDIDATES}`, t.params)).rows;

  const scores = rrf([vRows.map(r => Number(r.id)), tRows.map(r => Number(r.id))]);
  if (!scores.size) return [];
  const info = (await d.db.query(
    `SELECT c.id, c.section_id, c.document_id, c.page, s.text, s.heading, d.name, d.web_url, d.period_start, d.period_end
     FROM ${s}.chunks c JOIN ${s}.sections s ON s.id = c.section_id JOIN ${s}.documents d ON d.id = c.document_id
     WHERE c.id = ANY($1::bigint[])`, [[...scores.keys()]])).rows;

  const bySection = new Map<number, Passage>();
  for (const r of info) {
    const score = scores.get(Number(r.id))!;
    const sid = Number(r.section_id);
    const prev = bySection.get(sid);
    if (prev && prev.score >= score) continue;
    bySection.set(sid, {
      sectionId: sid, documentId: Number(r.document_id), text: r.text, heading: r.heading, file: r.name, page: r.page,
      link: r.web_url, period: r.period_start ? (r.period_start === r.period_end ? r.period_start : `${r.period_start} to ${r.period_end}`) : null, score,
    });
  }
  return [...bySection.values()].sort((a, b) => b.score - a.score).slice(0, input.k);
}
