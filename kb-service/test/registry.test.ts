import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.ts';
import {
  GenError, activeGeneration, createGeneration, cutover, discardGeneration, dropExpired, getGeneration,
  listGenerations, rollback, setGeneration, writableGenerations,
} from '../src/gen/registry.ts';
import { freshDb } from './helpers.ts';

let db: Db;
beforeEach(async () => { if (db) await db.end(); db = await freshDb(); });
afterAll(async () => { await db.end(); });
const schemas = async () => (await db.query(`SELECT schema_name s FROM information_schema.schemata WHERE schema_name LIKE 'kb_g%' ORDER BY 1`)).rows.map(r => r.s);

describe('generation registry', () => {
  it('starts with generation 1 active', async () => {
    const g = await activeGeneration(db);
    expect(g).toMatchObject({ id: 1, status: 'active', embedding_model: 'fake-hash', embedding_dim: 384, build_total: 0, build_done: 0 });
  });

  it('creates one candidate at a time, with its own schema', async () => {
    expect(await createGeneration(db, 'fake-hash', 384, 'abc123')).toBe(2);
    expect(await schemas()).toEqual(['kb_g1', 'kb_g2']);
    expect(await getGeneration(db, 2)).toMatchObject({ status: 'building', config_version: 'abc123' });
    await expect(createGeneration(db, 'fake-hash', 384, null)).rejects.toThrow(GenError);
    expect((await writableGenerations(db)).map(g => g.id)).toEqual([1, 2]);
  });

  it('cuts over only to a ready generation, then rolls back', async () => {
    await createGeneration(db, 'fake-hash', 384, null);
    await expect(cutover(db, 2)).rejects.toThrow(/not ready/);
    await setGeneration(db, 2, { status: 'ready', eval_hit5: 0.9 });
    expect(await cutover(db, 2)).toEqual({ from: 1, to: 2 });
    expect((await activeGeneration(db)).id).toBe(2);
    expect(await getGeneration(db, 1)).toMatchObject({ status: 'retired' });
    expect((await getGeneration(db, 1))!.retired_at).toBeInstanceOf(Date);
    expect((await writableGenerations(db)).map(g => g.id)).toEqual([2, 1]);
    expect(await rollback(db)).toEqual({ from: 2, to: 1 });
    expect((await activeGeneration(db)).id).toBe(1);
    expect(await getGeneration(db, 2)).toMatchObject({ status: 'retired' });
  });

  it('refuses rollback with nothing retired', async () => {
    await expect(rollback(db)).rejects.toThrow(/Nothing to roll back/);
  });

  it('drops retired generations older than 7 days and discards candidates', async () => {
    await createGeneration(db, 'fake-hash', 384, null);
    await setGeneration(db, 2, { status: 'ready' });
    await cutover(db, 2);
    await db.query(`UPDATE kb_meta.generations SET retired_at = now() - interval '8 days' WHERE id = 1`);
    expect(await dropExpired(db)).toEqual([1]);
    expect(await schemas()).toEqual(['kb_g2']);
    expect((await writableGenerations(db)).map(g => g.id)).toEqual([2]);
    await createGeneration(db, 'fake-hash', 384, null);
    await discardGeneration(db, 3);
    expect(await getGeneration(db, 3)).toMatchObject({ status: 'dropped' });
    await expect(discardGeneration(db, 2)).rejects.toThrow(GenError);
    expect((await listGenerations(db)).map(g => `${g.id}:${g.status}`)).toEqual(['1:dropped', '2:active', '3:dropped']);
  });
});
