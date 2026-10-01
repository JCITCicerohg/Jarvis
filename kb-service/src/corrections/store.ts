import type { Db } from '../db/pool.ts';

export type Scope = 'global' | 'personal';
export type CStatus = 'pending' | 'approved' | 'rejected' | 'needs_review' | 'expired';
export interface Correction {
  id: number; text: string; original_message: string; author: string; created_at: Date; scope: Scope; status: CStatus;
  hotel: string | null; department: string | null; dataset: string | null; entities: string[]; period_start: string | null; period_end: string | null;
  embedding: number[] | null; embedding_model: string | null; review_due_at: Date | null; expires_at: Date | null;
  decided_by: string | null; decided_at: Date | null; superseded_by_item: string | null; note: string | null;
}
export interface NewCorrection {
  text: string; original_message: string; author: string; scope: Scope; hotel: string | null; department: string | null;
  dataset: string | null; entities: string[]; period_start: string | null; period_end: string | null; embedding: number[]; embedding_model: string;
}

/** A refusal by a rule (who may decide, unknown id): the API maps it to 403/404/409. */
export class CorrectionError extends Error {
  constructor(message: string, public status: 403 | 404 | 409) { super(message); }
}

export const PERSONAL_DAYS = 90;
export const GLOBAL_REVIEW_DAYS = 180;
const COLS = `id, text, original_message, author, created_at, scope, status, hotel, department, dataset, entities, period_start, period_end,
  embedding, embedding_model, review_due_at, expires_at, decided_by, decided_at, superseded_by_item, note`;
const LIVE = `status IN ('pending', 'approved', 'needs_review')`;

export async function createCorrection(db: Db, c: NewCorrection): Promise<Correction> {
  const personal = c.scope === 'personal';
  return (await db.query(
    `INSERT INTO kb_meta.corrections (text, original_message, author, scope, status, hotel, department, dataset, entities, period_start, period_end,
       embedding, embedding_model, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $14 THEN now() + interval '${PERSONAL_DAYS} days' END)
     RETURNING ${COLS}`,
    [c.text, c.original_message, c.author, c.scope, personal ? 'approved' : 'pending', c.hotel, c.department, c.dataset, c.entities,
      c.period_start, c.period_end, c.embedding, c.embedding_model, personal])).rows[0];
}

/** What one caller may see in answers: approved global corrections, plus their own live ones. */
export async function visibleCorrections(db: Db, user: string): Promise<Correction[]> {
  return (await db.query(
    `SELECT ${COLS} FROM kb_meta.corrections
     WHERE (scope = 'global' AND status IN ('approved', 'needs_review')) OR (author = $1 AND ${LIVE})
     ORDER BY created_at DESC`, [user])).rows;
}

/** Listing for review: admins see every global correction; everyone sees their own and approved global ones. */
export async function listCorrections(db: Db, o: { user: string; admin: boolean; status?: CStatus }): Promise<Correction[]> {
  const params: unknown[] = [o.user, o.admin];
  let where = `(author = $1 OR (scope = 'global' AND ($2 OR status <> 'pending')))`;
  if (o.status) { params.push(o.status); where += ` AND status = $3`; }
  return (await db.query(`SELECT ${COLS} FROM kb_meta.corrections WHERE ${where} ORDER BY created_at`, params)).rows;
}

export async function decideCorrection(db: Db, id: number, decision: 'approve' | 'reject' | 'keep' | 'retire', by: string, admin: boolean): Promise<Correction> {
  const c: Correction | undefined = (await db.query(`SELECT ${COLS} FROM kb_meta.corrections WHERE id = $1`, [id])).rows[0];
  if (!c) throw new CorrectionError(`No correction ${id}.`, 404);
  const own = c.author === by;
  if (decision === 'approve' || decision === 'reject') {
    if (!admin) throw new CorrectionError('Only an admin can approve or reject a company-wide correction.', 403);
    if (c.scope !== 'global') throw new CorrectionError('Personal corrections need no approval.', 409);
  } else if (c.scope === 'personal' ? !own : !admin && !own) {
    throw new CorrectionError('Only the author (or an admin, for company-wide corrections) can keep or retire it.', 403);
  }
  const set = {
    approve: `status = 'approved', review_due_at = now() + interval '${GLOBAL_REVIEW_DAYS} days'`,
    reject: `status = 'rejected'`,
    keep: c.scope === 'personal'
      ? `status = 'approved', superseded_by_item = NULL, expires_at = now() + interval '${PERSONAL_DAYS} days'`
      : `status = 'approved', superseded_by_item = NULL, review_due_at = now() + interval '${GLOBAL_REVIEW_DAYS} days'`,
    retire: `status = 'expired'`,
  }[decision];
  return (await db.query(`UPDATE kb_meta.corrections SET ${set}, decided_by = $2, decided_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, by])).rows[0];
}

export async function updateEmbedding(db: Db, id: number, embedding: number[], model: string): Promise<void> {
  await db.query(`UPDATE kb_meta.corrections SET embedding = $2, embedding_model = $3 WHERE id = $1`, [id, embedding, model]);
}

export async function expireCorrections(db: Db): Promise<{ expired: number; review: number }> {
  const e = await db.query(`UPDATE kb_meta.corrections SET status = 'expired' WHERE scope = 'personal' AND ${LIVE} AND expires_at <= now()`);
  const r = await db.query(`UPDATE kb_meta.corrections SET status = 'needs_review' WHERE scope = 'global' AND status = 'approved' AND review_due_at <= now()`);
  return { expired: e.rowCount ?? 0, review: r.rowCount ?? 0 };
}

/** A newer official file on the same hotel + dataset (or entity) sends overlapping corrections to review. */
export async function flagSuperseded(db: Db, doc: { hotel: string | null; dataset: string | null; entities: string[]; modifiedAt: string; driveItemId: string }): Promise<number> {
  if (!doc.hotel) return 0;
  const r = await db.query(
    `UPDATE kb_meta.corrections SET status = 'needs_review', superseded_by_item = $5
     WHERE status IN ('pending', 'approved') AND lower(hotel) = lower($1)
       AND (lower(dataset) = lower($2) OR entities && $3::text[]) AND created_at < $4::timestamptz`,
    [doc.hotel, doc.dataset ?? '', doc.entities, doc.modifiedAt, doc.driveItemId]);
  return r.rowCount ?? 0;
}
