import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/query/catalog.ts';
import { EXTRACT_SCHEMA, extractCorrection } from '../src/corrections/extract.ts';

const CAT: Catalog = { hotels: ['Hilton Palm Beach PBI'], departments: ['Engineering'], fileTypes: ['xlsx'], datasets: [{ name: 'Hilton Projects', department: null, from: '2026-01-01', to: '2026-09-30', files: 1, columns: null }] };
const model = (out: unknown) => ({ name: 'fake', calls: [] as unknown[], async json(system: string, user: string, schema: Record<string, unknown>) { this.calls.push({ system, user, schema }); return out; } });

describe('extractCorrection', () => {
  it('returns a validated fact with canonical subject names and an exact period', async () => {
    const m = model({ fact: 'The lobby renovation slipped to Q4 2026.', clarify: null, hotel: 'hilton palm beach pbi', department: null, dataset: 'hilton projects', entities: ['Lobby renovation'], period_from: '2026-10', period_to: '2026-12' });
    const r = await extractCorrection(m, 'actually the lobby reno slipped to Q4', CAT, '2026-10-01');
    expect(r).toEqual({ kind: 'fact', text: 'The lobby renovation slipped to Q4 2026.', hotel: 'Hilton Palm Beach PBI', department: null, dataset: 'Hilton Projects', entities: ['Lobby renovation'], period_start: '2026-10-01', period_end: '2026-12-31', notes: [] });
    expect(JSON.stringify(m.calls[0])).toContain('Today: 2026-10-01');
    expect((m.calls[0] as { schema: unknown }).schema).toBe(EXTRACT_SCHEMA);
  });

  it('asks a clarifying question instead of guessing', async () => {
    const r = await extractCorrection(model({ fact: '', clarify: 'Which hotel do you mean?', hotel: null, department: null, dataset: null, entities: [], period_from: null, period_to: null }), 'that place slipped to Q4', CAT, '2026-10-01');
    expect(r).toEqual({ kind: 'clarify', question: 'Which hotel do you mean?' });
  });

  it('drops unknown subject values with a note', async () => {
    const r = await extractCorrection(model({ fact: 'Pool closes at 9.', clarify: null, hotel: 'Marriott', department: null, dataset: null, entities: [], period_from: null, period_to: null }), 'pool closes at 9', CAT, '2026-10-01');
    expect(r).toMatchObject({ kind: 'fact', hotel: null, notes: ['No hotel called "Marriott" in the knowledge base; saved without a hotel.'] });
  });

  it('rejects malformed model output', async () => {
    await expect(extractCorrection(model({ nope: 1 }), 'x', CAT, '2026-10-01')).rejects.toThrow(/invalid correction/);
  });
});
