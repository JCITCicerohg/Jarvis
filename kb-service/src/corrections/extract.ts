import { z } from 'zod';
import type { JsonModel } from '../llm/json-model.ts';
import type { Catalog } from '../query/catalog.ts';
import { canonical, normalizeRange } from '../query/validate.ts';

const str = { type: 'string' };
const nullableStr = { anyOf: [{ type: 'null' }, str] };
export const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['fact', 'clarify', 'hotel', 'department', 'dataset', 'entities', 'period_from', 'period_to'],
  properties: {
    fact: str, clarify: nullableStr, hotel: nullableStr, department: nullableStr, dataset: nullableStr,
    entities: { type: 'array', items: str }, period_from: nullableStr, period_to: nullableStr,
  },
};

const Out = z.object({
  fact: z.string(), clarify: z.string().nullable(), hotel: z.string().nullable(), department: z.string().nullable(), dataset: z.string().nullable(),
  entities: z.array(z.string()), period_from: z.string().nullable(), period_to: z.string().nullable(),
});

export const EXTRACT_SYSTEM = `You turn a hotel executive's correction about their business into one standalone fact for a knowledge base. You never answer questions.
- fact: one sentence that stands alone without the conversation (name the thing and the new information, with concrete dates).
- hotel, department, dataset: values from the catalog only, spelled as the catalog spells them, or null.
- entities: names of projects, vendors, people or outlets the fact is about.
- period_from / period_to: the dates the fact is about as YYYY, YYYY-MM or YYYY-MM-DD, resolved from Today; null if none.
- clarify: if you cannot tell what the correction is about (which hotel, which project), set fact to "" and ask one short question here; otherwise null.`;

export type Extracted =
  | { kind: 'fact'; text: string; hotel: string | null; department: string | null; dataset: string | null; entities: string[]; period_start: string | null; period_end: string | null; notes: string[] }
  | { kind: 'clarify'; question: string };

export async function extractCorrection(model: JsonModel, message: string, catalog: Catalog, today: string): Promise<Extracted> {
  const raw = await model.json(EXTRACT_SYSTEM, `Today: ${today}\n\nCatalog:\n${JSON.stringify(catalog)}\n\nCorrection: ${message}`, EXTRACT_SCHEMA);
  const p = Out.safeParse(raw);
  if (!p.success) throw new Error('extractor returned an invalid correction: ' + p.error.message.slice(0, 200));
  const o = p.data;
  if (o.clarify?.trim() || !o.fact.trim()) return { kind: 'clarify', question: o.clarify?.trim() || 'What exactly should I correct?' };
  const notes: string[] = [];
  const pick = (field: 'hotel' | 'department' | 'dataset', v: string | null) => {
    if (!v) return null;
    const c = canonical(catalog, field, v);
    if (!c) notes.push(`No ${field} called "${v}" in the knowledge base; saved without a ${field}.`);
    return c;
  };
  const range = o.period_from && o.period_to ? normalizeRange(o.period_from, o.period_to) : null;
  return {
    kind: 'fact', text: o.fact.trim(), hotel: pick('hotel', o.hotel), department: pick('department', o.department), dataset: pick('dataset', o.dataset),
    entities: o.entities.map(e => e.trim()).filter(Boolean), period_start: range?.from ?? null, period_end: range?.to ?? null, notes,
  };
}
