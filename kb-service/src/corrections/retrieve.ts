import type { Db } from '../db/pool.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { QueryPlan } from '../query/plan.ts';
import type { Filter } from '../query/filter.ts';
import { updateEmbedding, visibleCorrections, type Correction } from './store.ts';

export interface ResultCorrection {
  text: string; author: string; created: string; scope: 'global' | 'personal'; status: 'approved' | 'pending' | 'needs_review'; contradicts?: string;
}

const MIN_SIMILARITY = 0.25;
const cos = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Hotel/dataset values the plan's filter pins (AND branches only), lower-cased. */
function pinned(f: Filter, field: 'hotel' | 'dataset'): string[] {
  if ('and' in f) return f.and.flatMap(x => pinned(x, field));
  return 'field' in f && f.field === field && 'eq' in f ? [f.eq.toLowerCase()] : [];
}

export async function findCorrections(
  d: { db: Db; embedder: Embedder },
  input: { user: string; question: string; plan: QueryPlan; cited: { file: string; hotel?: string | null; dataset?: string | null }[] },
  k = 5,
): Promise<ResultCorrection[]> {
  const all = await visibleCorrections(d.db, input.user);
  if (!all.length) return [];
  const hotels = pinned(input.plan.filter, 'hotel'), datasets = pinned(input.plan.filter, 'dataset');
  const inScope = (c: Correction) => (!hotels.length || !c.hotel || hotels.includes(c.hotel.toLowerCase()))
    && (!datasets.length || !c.dataset || datasets.includes(c.dataset.toLowerCase()));
  const candidates = all.filter(inScope);
  for (const c of candidates) {
    if (c.embedding_model !== d.embedder.model || !c.embedding) {
      [c.embedding] = await d.embedder.embed([c.text]);
      await updateEmbedding(d.db, c.id, c.embedding!, d.embedder.model);
    }
  }
  const [qv] = await d.embedder.embed([[input.question, ...input.plan.semantic].join(' ; ')]);
  return candidates
    .map(c => ({ c, score: cos(qv, c.embedding!) }))
    .filter(x => x.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c }) => {
      const hit = input.cited.find(s => (c.dataset && s.dataset?.toLowerCase() === c.dataset.toLowerCase()) || s.file.toLowerCase().includes((c.dataset ?? '\u0000').toLowerCase()));
      return {
        text: c.text, author: c.author, created: c.created_at.toISOString().slice(0, 10), scope: c.scope,
        status: c.status as ResultCorrection['status'], ...(hit ? { contradicts: hit.file } : {}),
      };
    });
}
