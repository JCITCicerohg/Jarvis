import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.ts';
import {
  CorrectionError, createCorrection, decideCorrection, expireCorrections, flagSuperseded, listCorrections, visibleCorrections, type NewCorrection,
} from '../src/corrections/store.ts';
import { freshDb, queryDb } from './helpers.ts';

let db: Db, q: Db;
const base = (over: Partial<NewCorrection> = {}): NewCorrection => ({
  text: 'The lobby renovation slipped to Q4 2026.', original_message: 'actually the lobby reno slipped to Q4', author: 'owner', scope: 'global',
  hotel: 'Hilton Palm Beach PBI', department: null, dataset: 'Hilton Projects', entities: ['Lobby renovation'], period_start: null, period_end: null,
  embedding: [1, 0, 0], embedding_model: 'fake-hash', ...over,
});
const texts = (cs: { text: string }[]) => cs.map(c => c.text).sort();

beforeEach(async () => { if (q) await q.end(); if (db) await db.end(); db = await freshDb(); q = queryDb(); });
afterAll(async () => { await q.end(); await db.end(); });

describe('correction store (runs as kb_query)', () => {
  it('creates global corrections pending and personal ones approved, with time limits', async () => {
    const g = await createCorrection(q, base());
    expect(g).toMatchObject({ scope: 'global', status: 'pending', author: 'owner', expires_at: null, review_due_at: null });
    const p = await createCorrection(q, base({ scope: 'personal', text: 'My team focuses on F&B this quarter.' }));
    expect(p.status).toBe('approved');
    expect(p.expires_at!.getTime() - p.created_at.getTime()).toBeCloseTo(90 * 86_400_000, -5);
  });

  it('shows each user only what they may see', async () => {
    const pendingByOwner = await createCorrection(q, base({ text: 'owner pending global' }));
    await createCorrection(q, base({ text: 'owner personal', scope: 'personal' }));
    await createCorrection(q, base({ text: 'exec personal', scope: 'personal', author: 'exec' }));
    const approved = await createCorrection(q, base({ text: 'approved global', author: 'exec' }));
    await decideCorrection(q, approved.id, 'approve', 'owner-admin', true);
    const rejected = await createCorrection(q, base({ text: 'rejected global', author: 'exec' }));
    await decideCorrection(q, rejected.id, 'reject', 'owner-admin', true);
    expect(texts(await visibleCorrections(q, 'owner'))).toEqual(['approved global', 'owner pending global', 'owner personal']);
    expect(texts(await visibleCorrections(q, 'exec'))).toEqual(['approved global', 'exec personal']);
    expect(texts(await listCorrections(q, { user: 'exec', admin: true, status: 'pending' }))).toEqual(['owner pending global']);
    expect(texts(await listCorrections(q, { user: 'exec', admin: false }))).toEqual(['approved global', 'exec personal', 'rejected global']);
    expect(pendingByOwner.status).toBe('pending');
  });

  it('enforces who may decide what', async () => {
    const g = await createCorrection(q, base());
    await expect(decideCorrection(q, g.id, 'approve', 'owner', false)).rejects.toThrow(CorrectionError);
    const a = await decideCorrection(q, g.id, 'approve', 'owner-admin', true);
    expect(a).toMatchObject({ status: 'approved', decided_by: 'owner-admin' });
    expect(a.review_due_at!.getTime() - a.decided_at!.getTime()).toBeCloseTo(180 * 86_400_000, -5);
    const p = await createCorrection(q, base({ scope: 'personal', author: 'exec' }));
    await expect(decideCorrection(q, p.id, 'retire', 'owner', false)).rejects.toThrow(/only the author/i);
    expect((await decideCorrection(q, p.id, 'retire', 'exec', false)).status).toBe('expired');
    await expect(decideCorrection(q, 999, 'approve', 'owner-admin', true)).rejects.toThrow(/No correction 999/);
  });

  it('expires personal corrections and sends old global ones to review', async () => {
    const p = await createCorrection(q, base({ scope: 'personal' }));
    const g = await createCorrection(q, base());
    await decideCorrection(q, g.id, 'approve', 'owner-admin', true);
    await db.query(`UPDATE kb_meta.corrections SET expires_at = now() - interval '1 day' WHERE id = $1`, [p.id]);
    await db.query(`UPDATE kb_meta.corrections SET review_due_at = now() - interval '1 day' WHERE id = $1`, [g.id]);
    expect(await expireCorrections(q)).toEqual({ expired: 1, review: 1 });
    expect((await listCorrections(q, { user: 'owner', admin: true })).map(c => c.status).sort()).toEqual(['expired', 'needs_review']);
  });

  it('flags corrections a newer official file supersedes', async () => {
    const c = await createCorrection(q, base());
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await flagSuperseded(q, { hotel: 'Hilton Palm Beach PBI', dataset: 'Room Renovations', entities: [], modifiedAt: later, driveItemId: 'X' })).toBe(0);
    expect(await flagSuperseded(q, { hotel: 'Hilton Palm Beach PBI', dataset: 'Hilton Projects', entities: [], modifiedAt: '2020-01-01T00:00:00Z', driveItemId: 'OLD' })).toBe(0);
    expect(await flagSuperseded(q, { hotel: 'Hilton Palm Beach PBI', dataset: 'Hilton Projects', entities: [], modifiedAt: later, driveItemId: 'NEW' })).toBe(1);
    expect((await listCorrections(q, { user: 'owner', admin: true }))[0]).toMatchObject({ id: c.id, status: 'needs_review', superseded_by_item: 'NEW' });
  });
});
