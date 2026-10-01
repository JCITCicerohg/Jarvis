import { generationDdl, gschema } from '../db/migrate.ts';
import { withTx, type Db } from '../db/pool.ts';

export type GenStatus = 'building' | 'catching_up' | 'ready' | 'active' | 'retired' | 'dropped' | 'failed';
export interface Generation {
  id: number; status: GenStatus; embedding_model: string; embedding_dim: number; config_version: string | null;
  created_at: Date; cutover_at: Date | null; retired_at: Date | null; eval_hit5: number | null; eval_mrr: number | null;
  build_total: number; build_done: number; note: string | null;
}

/** A refusal by a business rule (not a fault): the API maps it to 409. */
export class GenError extends Error {}

export const RETENTION_DAYS = 7;
const COLS = 'id, status, embedding_model, embedding_dim, config_version, created_at, cutover_at, retired_at, eval_hit5, eval_mrr, build_total, build_done, note';
const CANDIDATE = `status IN ('building', 'catching_up', 'ready')`;
const ACTIVE_ID = `(SELECT (value #>> '{}')::int FROM kb_meta.settings WHERE key = 'active_generation')`;

export async function listGenerations(db: Db): Promise<Generation[]> {
  return (await db.query(`SELECT ${COLS} FROM kb_meta.generations ORDER BY id`)).rows;
}

export async function getGeneration(db: Db, id: number): Promise<Generation | null> {
  return (await db.query(`SELECT ${COLS} FROM kb_meta.generations WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function activeGeneration(db: Db): Promise<Generation> {
  const g = (await db.query(`SELECT ${COLS} FROM kb_meta.generations WHERE id = ${ACTIVE_ID}`)).rows[0];
  if (!g) throw new Error('No active generation; run migrate first.');
  return g;
}

/** Generations that receive every sync change: active first, then candidates and recently retired ones. */
export async function writableGenerations(db: Db): Promise<Generation[]> {
  return (await db.query(
    `SELECT ${COLS} FROM kb_meta.generations
     WHERE status = 'active' OR ${CANDIDATE} OR (status = 'retired' AND retired_at > now() - interval '${RETENTION_DAYS} days')
     ORDER BY (status = 'active') DESC, id DESC`)).rows;
}

export async function createGeneration(db: Db, model: string, dim: number, configVersion: string | null): Promise<number> {
  const busy = (await db.query(`SELECT id FROM kb_meta.generations WHERE ${CANDIDATE}`)).rows[0];
  if (busy) throw new GenError(`Generation ${busy.id} is already being built; cut over to it or discard it first.`);
  const id = Number((await db.query('SELECT coalesce(max(id), 0) + 1 AS n FROM kb_meta.generations')).rows[0].n);
  await db.query(generationDdl(id, dim));
  await db.query(
    `INSERT INTO kb_meta.generations (id, status, embedding_model, embedding_dim, config_version) VALUES ($1, 'building', $2, $3, $4)`,
    [id, model, dim, configVersion]);
  return id;
}

type Settable = Partial<Pick<Generation, 'status' | 'eval_hit5' | 'eval_mrr' | 'build_total' | 'build_done' | 'note'>>;
const SETTABLE = ['status', 'eval_hit5', 'eval_mrr', 'build_total', 'build_done', 'note'] as const;

export async function setGeneration(db: Db, id: number, fields: Settable): Promise<void> {
  const keys = SETTABLE.filter(k => k in fields);
  if (!keys.length) return;
  await db.query(`UPDATE kb_meta.generations SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map(k => fields[k])]);
}

async function flip(db: Db, pick: (tx: import('../db/pool.ts').Tx, active: number) => Promise<number>): Promise<{ from: number; to: number }> {
  return withTx(db, async tx => {
    const active = Number((await tx.query(`SELECT (value #>> '{}')::int AS id FROM kb_meta.settings WHERE key = 'active_generation' FOR UPDATE`)).rows[0].id);
    const to = await pick(tx, active);
    await tx.query(`UPDATE kb_meta.generations SET status = 'retired', retired_at = now() WHERE id = $1`, [active]);
    await tx.query(`UPDATE kb_meta.generations SET status = 'active', cutover_at = now(), retired_at = NULL WHERE id = $1`, [to]);
    await tx.query(`UPDATE kb_meta.settings SET value = to_jsonb($1::int) WHERE key = 'active_generation'`, [to]);
    return { from: active, to };
  });
}

/** Makes a ready generation active in one transaction; the old one is retired (kept 7 days for rollback). */
export function cutover(db: Db, id: number): Promise<{ from: number; to: number }> {
  return flip(db, async tx => {
    const g = (await tx.query('SELECT status FROM kb_meta.generations WHERE id = $1', [id])).rows[0];
    if (!g) throw new GenError(`No generation ${id}.`);
    if (g.status !== 'ready') throw new GenError(`Generation ${id} is not ready (status ${g.status}).`);
    return id;
  });
}

/** Re-activates the most recently retired generation (within the retention window). */
export function rollback(db: Db): Promise<{ from: number; to: number }> {
  return flip(db, async (tx, active) => {
    const prev = (await tx.query(
      `SELECT id FROM kb_meta.generations WHERE status = 'retired' AND id <> $1 AND retired_at > now() - interval '${RETENTION_DAYS} days'
       ORDER BY retired_at DESC LIMIT 1`, [active])).rows[0];
    if (!prev) throw new GenError('Nothing to roll back to: no generation was retired in the last 7 days.');
    return Number(prev.id);
  });
}

/** Throws away a candidate generation (not the active or a retired one). */
export async function discardGeneration(db: Db, id: number): Promise<void> {
  const g = await getGeneration(db, id);
  if (!g || !['building', 'catching_up', 'ready', 'failed'].includes(g.status)) throw new GenError(`Generation ${id} is not a candidate and cannot be discarded.`);
  await db.query(`DROP SCHEMA IF EXISTS ${gschema(id)} CASCADE`);
  await setGeneration(db, id, { status: 'dropped' });
}

export async function dropExpired(db: Db): Promise<number[]> {
  const old = (await db.query(`SELECT id FROM kb_meta.generations WHERE status = 'retired' AND retired_at <= now() - interval '${RETENTION_DAYS} days'`)).rows;
  for (const { id } of old) {
    await db.query(`DROP SCHEMA IF EXISTS ${gschema(Number(id))} CASCADE`);
    await setGeneration(db, Number(id), { status: 'dropped' });
  }
  return old.map(r => Number(r.id));
}
