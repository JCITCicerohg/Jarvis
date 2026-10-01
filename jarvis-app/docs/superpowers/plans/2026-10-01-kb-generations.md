# KB Generations (Plan 3 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Updates never break the live knowledge base: content changes merge into the active generation (fast lane for normal edits, a throttled slow lane for bulk), rule changes are rebuilt into a new generation from the archived originals while live keeps serving, a gate (build complete, errors no worse, eval hit@5 ≥ 0.85 and ≥ live) marks it ready, the owner approves a seconds-long cutover, and rollback stays instant for 7 days. A separate opt-in kb-test environment runs against a test folder.

**Architecture:** `kb_meta.generations` becomes a lifecycle table (building → catching_up → ready → active → retired → dropped). `GenerationManager` owns it: it hands sync the active generation plus every other writable generation (fan-out), builds a new generation from `raw/` blobs in the background, evaluates it with the eval set, and performs cutover/rollback in one transaction. The query path resolves the active generation and its embedder per request. Each generation keeps its own embedding model (`embedderFor(model)`) and its own Parquet folder (`tidy/g<N>/…`). Admin endpoints (`/v1/admin/*`, separate admin keys) drive it; Jarvis gets gated tools for cutover and rollback.

**Tech Stack:** existing kb-service stack (TypeScript, Express 5, node-postgres, pgvector, DuckDB, vitest); Docker Compose profiles for kb-test.

**Spec:** `jarvis-app/docs/superpowers/specs/2026-09-30-sharepoint-knowledge-base-design.md` (rev 4) §4 (environments and generations), §9 admin routes, §10 Apps/approval integration.

## Global Constraints

- Generation statuses: `building`, `catching_up`, `ready`, `active`, `retired`, `dropped`, `failed`. Exactly one `active`; at most one of `building`/`catching_up`/`ready` at a time.
- Writable generations (receive every sync change): `active`, `building`, `catching_up`, `ready`, and `retired` with `retired_at` within the last 7 days. Older retired generations are dropped (`DROP SCHEMA kb_g<N> CASCADE`) by a daily job.
- Gate (all must hold for `ready`): build finished (`build_done ≥ build_total`); candidate error count ≤ live error count; eval hit@5 ≥ 0.85 and ≥ the live generation's hit@5 on the same questions.
- Cutover and rollback each run in one transaction that flips `kb_meta.settings.active_generation`; no restart; queries resolve the active generation per request.
- Slow lane: a sync run switches to throttled mode (20 files/min) during a resync/backfill, after 200 changed files, or after 10% of a source with ≥ 100 documents; it pauses while query p95 latency over the last 5 minutes exceeds 1,500 ms (eval queries excluded). Normal small batches take the fast lane (no throttle).
- Each generation records `embedding_model`, `embedding_dim` and `config_version` (`KB_CONFIG_VERSION`, set to the git commit by the deploy script). The configured `KB_EMBED_PROVIDER` only decides the model of the *next* generation; a running generation always uses its own model.
- Parquet keys are generation-scoped: `tidy/g<N>/<source>/<dataset>/<driveItemId>-<sheet>.parquet`. Raw originals stay shared: `raw/<source>/<driveItemId>/<ctag>`.
- Admin endpoints need a key from `KB_ADMIN_KEYS` (name:key pairs); query keys (`KB_API_KEYS`) are refused there (401). Business-rule refusals (not ready, nothing to roll back, build already running) return 409.
- kb-test is opt-in: started only when `KB_TEST_ENABLED=1` in `deploy/.env`; its own database `kb_test`, blob volume, and `config/sources.test.yaml` (folder `Jarvis KB Test` on the same SharePoint drive).
- Secrets rules from Plans 1–2 stand (never read/print/commit `.env` files, `.env_api/`, `deploy/.env`, `deploy/kb.env`, `deploy/.secrets.json`).

## Review Focus

1. **A file changes while a new generation is being built:** the build must not overwrite the newer version written by fan-out with the older archived copy. Test in Task 4.
2. **A file reported "unchanged" with a new cTag** (SharePoint re-saved identical bytes): the build must still find its raw original. Test in Task 2.
3. **Cutover or rollback racing a query:** a query uses one generation from start to finish; nothing reads a half-switched state. Tested by per-request resolution (Task 7) and the single-transaction flip (Task 1).
4. **Two builds at once / cutover to an unready generation / rollback with nothing retired:** refused with a clear 409, state unchanged. Tests in Tasks 1 and 7.
5. **A generation built with a different embedding model:** its queries embed with its own model, not the configured one. Test in Tasks 2 and 6.

---

### Task 1: Generation lifecycle registry

**Files:**
- Create: `kb-service/src/gen/registry.ts`
- Modify: `kb-service/src/db/migrate.ts` (lifecycle columns; no refusal on model mismatch)
- Modify: `kb-service/test/migrate.test.ts` (replace the "refuses a different embedding model" test)
- Modify: `kb-service/test/helpers.ts` (`freshDb` drops every `kb_g*` schema, not just `kb_g1`)
- Test: `kb-service/test/registry.test.ts`

**Interfaces:**
- Produces: `type GenStatus`; `interface Generation { id: number; status: GenStatus; embedding_model: string; embedding_dim: number; config_version: string | null; created_at: Date; cutover_at: Date | null; retired_at: Date | null; eval_hit5: number | null; eval_mrr: number | null; build_total: number; build_done: number; note: string | null }`; `class GenError extends Error`; `RETENTION_DAYS = 7`; `listGenerations(db)`, `getGeneration(db, id)`, `activeGeneration(db)`, `writableGenerations(db)` (active first), `createGeneration(db, model, dim, configVersion): Promise<number>`, `setGeneration(db, id, fields)`, `cutover(db, id): Promise<{ from: number; to: number }>`, `rollback(db): Promise<{ from: number; to: number }>`, `discardGeneration(db, id)`, `dropExpired(db): Promise<number[]>`.

- [ ] **Step 1: Write the failing test**

`kb-service/test/registry.test.ts`:
```ts
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
```

In `kb-service/test/migrate.test.ts`, replace the test
```ts
  it('refuses a different embedding model on an existing generation', async () => {
    await expect(migrate(db, 'text-embedding-3-small', 1536)).rejects.toThrow(/built with fake-hash \(384 dims\)/);
  });
```
with
```ts
  it('keeps the active generation when a different embedding model is configured', async () => {
    expect(await migrate(db, 'text-embedding-3-small', 1536)).toBe(1);
    const g = (await db.query('SELECT embedding_model, embedding_dim FROM kb_meta.generations WHERE id = 1')).rows[0];
    expect(g).toEqual({ embedding_model: 'fake-hash', embedding_dim: 384 });
  });
```

In `kb-service/test/helpers.ts`, replace the drop line in `freshDb` with:
```ts
  await db.query(`
    DROP SCHEMA IF EXISTS kb_meta CASCADE;
    DO $$ DECLARE s text; BEGIN
      FOR s IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'kb\\_g%' LOOP
        EXECUTE 'DROP SCHEMA ' || quote_ident(s) || ' CASCADE';
      END LOOP;
    END $$;`);
```
(Generation schemas created by one test must not leak into the next.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `kb-service/`): `npx vitest run test/registry.test.ts test/migrate.test.ts`
Expected: registry FAIL (module missing); migrate's replaced test FAIL (still throws).

- [ ] **Step 3: Implement**

In `kb-service/src/db/migrate.ts`, append to the `META` string (after the `query_log` table):
```sql
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS config_version text;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS eval_hit5 real;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS eval_mrr real;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS build_total int NOT NULL DEFAULT 0;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS build_done int NOT NULL DEFAULT 0;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS note text;
```
and replace the model-mismatch block
```ts
  const g = (await db.query('SELECT embedding_model, embedding_dim FROM kb_meta.generations WHERE id = $1', [active])).rows[0];
  if (g.embedding_model !== embeddingModel || g.embedding_dim !== dim) {
    throw new Error(`Generation ${active} was built with ${g.embedding_model} (${g.embedding_dim} dims), but the configured embedder is ${embeddingModel} (${dim} dims). Set KB_EMBED_PROVIDER back, or rebuild into a new generation.`);
  }
  await db.query(generationDdl(active, dim));
```
with
```ts
  // The active generation keeps its own model; the configured embedder is used for the next generation (Plan 3).
  const g = (await db.query('SELECT embedding_dim FROM kb_meta.generations WHERE id = $1', [active])).rows[0];
  await db.query(generationDdl(active, g.embedding_dim));
```
Update the doc comment above `migrate` to say: "Creates or updates kb_meta and the active generation's schema. Returns the active generation; its embedding model is never changed here."

`kb-service/src/gen/registry.ts`:
```ts
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
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/registry.test.ts test/migrate.test.ts && npx tsc --noEmit && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/gen/registry.ts kb-service/src/db/migrate.ts kb-service/test/registry.test.ts kb-service/test/migrate.test.ts
git commit -m "feat(kb): generation lifecycle registry with transactional cutover and rollback"
```

---

### Task 2: Per-generation embedders, Parquet folders and raw archiving

**Files:**
- Create: `kb-service/src/embed/registry.ts`
- Modify: `kb-service/src/ingest/pipeline.ts` (tidy key gains `g<N>`; the "unchanged" path archives the raw bytes under the new cTag)
- Test: `kb-service/test/embed-registry.test.ts`; add tests to `kb-service/test/ingest.test.ts`

**Interfaces:**
- Consumes: `LocalEmbedder`, `HttpEmbedder`, `FakeEmbedder`, `openaiEmbedTarget`, `azureEmbedTarget` (embedder.ts); `Env`.
- Produces: `embedderFor(model: string, env: Pick<Env, 'openaiKey' | 'azure'>): Embedder` (cached per model); `rawKey(sourceId, driveItemId, tag): string` exported from pipeline.ts.

- [ ] **Step 1: Write the failing tests**

`kb-service/test/embed-registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { embedderFor } from '../src/embed/registry.ts';

const env = { openaiKey: 'sk', azure: { endpoint: 'https://tiro.openai.azure.com', key: 'az', apiVersion: '2024-10-21', embedDeployment: 'ignored' } };

describe('embedderFor', () => {
  it('maps every stored model name to its embedder, cached', () => {
    expect(embedderFor('fake-hash', env)).toMatchObject({ model: 'fake-hash', dim: 384 });
    expect(embedderFor('local:Xenova/bge-small-en-v1.5', env)).toMatchObject({ model: 'local:Xenova/bge-small-en-v1.5', dim: 384 });
    expect(embedderFor('text-embedding-3-small', env)).toMatchObject({ model: 'text-embedding-3-small', dim: 1536 });
    expect(embedderFor('azure:emb-small', env)).toMatchObject({ model: 'azure:emb-small', dim: 1536 });
    expect(embedderFor('fake-hash', env)).toBe(embedderFor('fake-hash', env));
  });
  it('refuses unknown models', () => {
    expect(() => embedderFor('mystery-model', env)).toThrow(/No embedder for model "mystery-model"/);
  });
});
```

Add to `kb-service/test/ingest.test.ts` inside `describe('ingestFile', …)`:
```ts
  it('writes Parquet under the generation folder', async () => {
    await ingestFile(d, SRC, item(), await glBook());
    const key = (await db.query('SELECT blob_key FROM kb_g1.datasets')).rows[0].blob_key;
    expect(key.startsWith('tidy/g1/hilton-pbi/')).toBe(true);
  });

  it('archives raw bytes under a new cTag even when the content is unchanged', async () => {
    const bytes = await glBook();
    await ingestFile(d, SRC, item({ ctag: 'c1' }), bytes);
    expect(await ingestFile(d, SRC, item({ ctag: 'c9' }), bytes)).toBe('unchanged');
    expect((await d.blob.get(rawKey('hilton-pbi', 'ITEM1', 'c9'))).equals(bytes)).toBe(true);
  });
```
and add `rawKey` to that file's import from `../src/ingest/pipeline.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/embed-registry.test.ts test/ingest.test.ts` → FAIL (module missing; key without `g1`; no `rawKey`).

- [ ] **Step 3: Implement**

`kb-service/src/embed/registry.ts`:
```ts
import type { Env } from '../config.ts';
import { FakeEmbedder, HttpEmbedder, LocalEmbedder, azureEmbedTarget, openaiEmbedTarget, type Embedder } from './embedder.ts';

const cache = new Map<string, Embedder>();

/** The embedder a generation was built with, from its stored model name. */
export function embedderFor(model: string, env: Pick<Env, 'openaiKey' | 'azure'>): Embedder {
  const hit = cache.get(model);
  if (hit) return hit;
  let e: Embedder;
  if (model === 'fake-hash') e = new FakeEmbedder();
  else if (model === 'local:Xenova/bge-small-en-v1.5') e = new LocalEmbedder();
  else if (model === 'text-embedding-3-small') e = new HttpEmbedder(openaiEmbedTarget(env.openaiKey));
  else if (model.startsWith('azure:')) e = new HttpEmbedder(azureEmbedTarget({ ...env.azure, embedDeployment: model.slice('azure:'.length) }));
  else throw new Error(`No embedder for model "${model}"`);
  cache.set(model, e);
  return e;
}
```

In `kb-service/src/ingest/pipeline.ts`:
1. Add, below `sha256`:
```ts
/** Raw originals are shared by all generations; rebuilds read them back by this key. */
export const rawKey = (sourceId: string, driveItemId: string, tag: string) => safeKey('raw', sourceId, driveItemId, tag);
```
2. In `build`, change the tidy key to:
```ts
      const key = safeKey('tidy', `g${d.gen}`, src.id, meta.dataset ?? 'misc', `${item.driveItemId}-${sheet.name}.parquet`);
```
3. In `ingestFile`, in the unchanged branch, archive before returning:
```ts
  if (prev && prev.content_hash === hash && prev.status === 'indexed') {
    await d.blob.put(rawKey(src.id, item.driveItemId, item.ctag ?? hash.slice(0, 16)), bytes);
    await withTx(d.db, async tx => { await upsertDoc(tx, s, item, meta, { status: 'indexed', hash }); await retagChunks(tx, s, Number(prev.id), meta); });
    return 'unchanged';
  }
```
4. Replace the existing raw put `await d.blob.put(safeKey('raw', src.id, item.driveItemId, item.ctag ?? hash.slice(0, 16)), bytes);` with `await d.blob.put(rawKey(src.id, item.driveItemId, item.ctag ?? hash.slice(0, 16)), bytes);`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/embed-registry.test.ts test/ingest.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/embed/registry.ts kb-service/src/ingest/pipeline.ts kb-service/test/embed-registry.test.ts kb-service/test/ingest.test.ts
git commit -m "feat(kb): per-generation embedders and Parquet folders; archive raw bytes on every cTag"
```

---

### Task 3: Sync fan-out to every writable generation, and the slow lane

**Files:**
- Create: `kb-service/src/sync/pacer.ts`
- Modify: `kb-service/src/sync/runner.ts`
- Test: `kb-service/test/pacer.test.ts`; add tests to `kb-service/test/sync.test.ts`

**Interfaces:**
- Consumes: `IngestDeps`, `ingestFile`, `deleteItem`, `upsertFolder` (pipeline).
- Produces: `interface Pacer { beforeFile(): Promise<void> }`; `class LatencyPacer(db, opts = { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 }, sleep = defaultSleep, now = Date.now)`; `queryP95(db): Promise<number>`; `interface SyncDeps extends IngestDeps { graph: GraphLike; extra?: IngestDeps[]; pacer?: Pacer }`; `syncSource(d: SyncDeps, src)`; constants `SLOW_AFTER_FILES = 200`, `SLOW_SHARE = 0.1`, `SLOW_MIN_DOCS = 100`.

- [ ] **Step 1: Write the failing tests**

`kb-service/test/pacer.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.ts';
import { LatencyPacer, queryP95 } from '../src/sync/pacer.ts';
import { freshDb } from './helpers.ts';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe('LatencyPacer', () => {
  it('spaces files at 20 per minute', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const p = new LatencyPacer(db, { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 }, async ms => { sleeps.push(ms); t += ms; }, () => t);
    await p.beforeFile();
    await p.beforeFile();
    t += 1000;
    await p.beforeFile();
    expect(sleeps).toEqual([3000, 2000]);
  });

  it('pauses while query p95 latency is over the limit, ignoring eval queries', async () => {
    await db.query(`INSERT INTO kb_meta.query_log (user_name, question, latency_ms) VALUES ('owner', 'slow', 5000), ('eval', 'e', 99999)`);
    expect(await queryP95(db)).toBe(5000);
    const sleeps: number[] = [];
    const p = new LatencyPacer(db, { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 }, async ms => {
      sleeps.push(ms);
      await db.query(`DELETE FROM kb_meta.query_log WHERE user_name = 'owner'`);
    }, () => 0);
    await p.beforeFile();
    expect(sleeps).toEqual([30_000]);
  });
});
```

Add to `kb-service/test/sync.test.ts` (inside `describe('syncSource', …)`; reuse its `FakeGraph`, `file`, `folder`, `START`, `deps`, `db`):
```ts
  it('applies every change to extra generations too', async () => {
    await db.query(`DROP SCHEMA IF EXISTS kb_g2 CASCADE`);
    const { generationDdl } = await import('../src/db/migrate.ts');
    await db.query(generationDdl(2, 384));
    const g = new FakeGraph();
    g.pages.set(START, { value: [folder('F1', 'Guest Scores', '/Hilton Palm Beach PBI'), file('A', 'a.txt', '/Hilton Palm Beach PBI/Guest Scores'), file('B', 'b.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd1' });
    const base = deps(g);
    const extra = { ...base, gen: 2 };
    await syncSource({ ...base, extra: [extra] }, SRC);
    const ids = async (s: string) => (await db.query(`SELECT drive_item_id FROM ${s}.documents ORDER BY 1`)).rows.map(r => r.drive_item_id);
    expect(await ids('kb_g2')).toEqual(['A', 'B']);
    expect((await db.query('SELECT count(*)::int n FROM kb_g2.folders')).rows[0].n).toBe(1);
    g.pages.set('d1', { value: [{ id: 'A', deleted: {} }], '@odata.deltaLink': 'd2' });
    await syncSource({ ...base, extra: [extra] }, SRC);
    expect(await ids('kb_g1')).toEqual(['B']);
    expect(await ids('kb_g2')).toEqual(['B']);
  });

  it('throttles a backfill (slow lane) but not a small delta (fast lane)', async () => {
    const g = new FakeGraph();
    g.pages.set(START, { value: [file('A', 'a.txt', '/Hilton Palm Beach PBI'), file('B', 'b.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd1' });
    let paced = 0;
    const pacer = { beforeFile: async () => { paced++; } };
    await syncSource({ ...deps(g), pacer }, SRC);
    expect(paced).toBe(2);
    g.pages.set('d1', { value: [file('C', 'c.txt', '/Hilton Palm Beach PBI')], '@odata.deltaLink': 'd2' });
    paced = 0;
    await syncSource({ ...deps(g), pacer }, SRC);
    expect(paced).toBe(0);
  });
```
At the top of `sync.test.ts`'s `beforeEach`, also clear generation 2 if present: change it to
```ts
beforeEach(async () => { await db.query('TRUNCATE kb_g1.documents, kb_g1.folders RESTART IDENTITY CASCADE; DELETE FROM kb_meta.sync_state; DROP SCHEMA IF EXISTS kb_g2 CASCADE'); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pacer.test.ts test/sync.test.ts` → FAIL (pacer module missing; extras/pacer ignored).

- [ ] **Step 3: Implement**

`kb-service/src/sync/pacer.ts`:
```ts
import type { Db } from '../db/pool.ts';

export interface Pacer { beforeFile(): Promise<void> }

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** p95 latency (ms) of real queries in the last 5 minutes; eval runs are excluded. */
export async function queryP95(db: Db): Promise<number> {
  const r = await db.query(
    `SELECT coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) AS p
     FROM kb_meta.query_log WHERE at > now() - interval '5 minutes' AND user_name IS DISTINCT FROM 'eval' AND latency_ms IS NOT NULL`);
  return Number(r.rows[0].p);
}

/** Slow lane: at most `perMinute` files, and none while users' queries are slow. */
export class LatencyPacer implements Pacer {
  private last = Number.NEGATIVE_INFINITY;
  constructor(
    private db: Db,
    private opts = { perMinute: 20, p95LimitMs: 1500, pauseMs: 30_000 },
    private sleep: (ms: number) => Promise<void> = defaultSleep,
    private now: () => number = Date.now,
  ) {}

  async beforeFile(): Promise<void> {
    while ((await queryP95(this.db)) > this.opts.p95LimitMs) await this.sleep(this.opts.pauseMs);
    const wait = this.last + 60_000 / this.opts.perMinute - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }
}
```

In `kb-service/src/sync/runner.ts`:
1. Add `import type { Pacer } from './pacer.ts';` and export:
```ts
export const SLOW_AFTER_FILES = 200;
export const SLOW_SHARE = 0.1;
export const SLOW_MIN_DOCS = 100;
export interface SyncDeps extends IngestDeps { graph: GraphLike; extra?: IngestDeps[]; pacer?: Pacer }
```
2. Change the signature to `export async function syncSource(d: SyncDeps, src: SourceConfig): Promise<SyncSummary> {` and, after `const s = gschema(d.gen);`, add:
```ts
  const all: IngestDeps[] = [d, ...(d.extra ?? [])];
  const docCount = Number((await d.db.query(`SELECT count(*)::int AS n FROM ${s}.documents WHERE source_id = $1`, [src.id])).rows[0].n);
  let changed = 0;
  const slowLane = () => sum.resync || changed > SLOW_AFTER_FILES || (docCount >= SLOW_MIN_DOCS && changed > docCount * SLOW_SHARE);
```
3. In the folders loop, replace the `await upsertFolder(d, src, {…});` call with:
```ts
        for (const t of all) await upsertFolder(t, src, { driveItemId: f.id, parentId: f.parentReference?.id ?? null, name: f.name!, folders: rel });
```
4. In the files loop, after the size check and before the download (`let bytes: Buffer;`), add:
```ts
        changed++;
        if (slowLane()) await d.pacer?.beforeFile();
```
and replace
```ts
        const r = await ingestFile(d, src, info, bytes);
        if (r === 'error') sum.errors++; else sum[r]++;
```
with
```ts
        const r = await ingestFile(d, src, info, bytes);
        for (const t of d.extra ?? []) await ingestFile(t, src, info, bytes);
        if (r === 'error') sum.errors++; else sum[r]++;
```
5. Replace the deletes line `for (const del of deletes) sum.deleted += await deleteItem(d, src.id, del.id);` with:
```ts
      for (const del of deletes) {
        sum.deleted += await deleteItem(d, src.id, del.id);
        for (const t of d.extra ?? []) await deleteItem(t, src.id, del.id);
      }
```
6. In the resync sweep, replace `for (const g of gone) sum.deleted += await deleteItem(d, src.id, g.drive_item_id);` with:
```ts
      for (const g of gone) {
        sum.deleted += await deleteItem(d, src.id, g.drive_item_id);
        for (const t of d.extra ?? []) await deleteItem(t, src.id, g.drive_item_id);
      }
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/pacer.test.ts test/sync.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/sync/pacer.ts kb-service/src/sync/runner.ts kb-service/test/pacer.test.ts kb-service/test/sync.test.ts
git commit -m "feat(kb): fan sync changes out to every writable generation; throttled slow lane for bulk"
```

---

### Task 4: Build lane — rebuild a generation from archived originals

**Files:**
- Create: `kb-service/src/gen/build.ts`
- Test: `kb-service/test/build.test.ts`

**Interfaces:**
- Consumes: `ingestFile`, `rawKey`, `IngestDeps`, `ItemInfo` (pipeline); `Pacer`; `SourceConfig`; `gschema`.
- Produces: `interface BuildDeps { db: Db; sources: SourceConfig[]; from: IngestDeps; to: IngestDeps; pacer?: Pacer; onProgress?(done: number, total: number): Promise<void> | void }`; `buildGeneration(d): Promise<{ total: number; done: number; skipped: number; errors: number }>`.

- [ ] **Step 1: Write the failing test**

`kb-service/test/build.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile, type ItemInfo } from '../src/ingest/pipeline.ts';
import { createGeneration } from '../src/gen/registry.ts';
import { buildGeneration } from '../src/gen/build.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
const item = (id: string, name: string, ctag = 'c1'): ItemInfo => ({ sourceId: 'hilton-pbi', driveItemId: id, parentId: null, name, folders: ['Guest Scores'], webUrl: `https://sp/${id}`, mime: null, size: 1, ctag, etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' });
let db: Db, blob: LocalBlobStore;
const g = (gen: number) => ({ db, gen, blob, embedder: new FakeEmbedder() });
const names = async (gen: number) => (await db.query(`SELECT name FROM kb_g${gen}.documents ORDER BY name`)).rows.map(r => r.name);

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-build-')));
  await db.query(`INSERT INTO kb_g1.folders (source_id, drive_item_id, parent_id, name, path) VALUES ('hilton-pbi', 'F1', NULL, 'Guest Scores', 'Guest Scores')`);
  await ingestFile(g(1), SRC, item('A', 'a.txt'), Buffer.from('Pool feedback was great.'));
  await ingestFile(g(1), SRC, item('B', 'b.txt'), Buffer.from('Breakfast scores improved.'));
  await createGeneration(db, 'fake-hash', 384, null);
});
afterAll(async () => { await db.end(); });

describe('buildGeneration', () => {
  it('rebuilds every document and folder from the raw archive, reporting progress', async () => {
    const progress: number[][] = [];
    const r = await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2), onProgress: (d, t) => { progress.push([d, t]); } });
    expect(r).toEqual({ total: 2, done: 2, skipped: 0, errors: 0 });
    expect(await names(2)).toEqual(['a.txt', 'b.txt']);
    expect((await db.query('SELECT count(*)::int n FROM kb_g2.chunks')).rows[0].n).toBeGreaterThan(0);
    expect((await db.query('SELECT count(*)::int n FROM kb_g2.folders')).rows[0].n).toBe(1);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it('never overwrites a newer version that fan-out already wrote', async () => {
    await ingestFile(g(2), SRC, item('A', 'a.txt', 'c2'), Buffer.from('NEWER pool feedback.'));
    const r = await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2) });
    expect(r.skipped).toBe(1);
    const text = (await db.query(`SELECT string_agg(c.text, ' ') t FROM kb_g2.chunks c JOIN kb_g2.documents d ON d.id = c.document_id WHERE d.drive_item_id = 'A'`)).rows[0].t;
    expect(text).toContain('NEWER');
  });

  it('counts a missing original as an error and skips sources no longer configured', async () => {
    await blob.remove('raw/hilton-pbi/b/c1');
    const r = await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2) });
    expect(r).toMatchObject({ done: 2, errors: 1 });
    const none = await buildGeneration({ db, sources: [], from: g(1), to: g(2) });
    expect(none).toMatchObject({ total: 2, skipped: 2 });
  });

  it('paces each rebuilt file', async () => {
    let paced = 0;
    await buildGeneration({ db, sources: [SRC], from: g(1), to: g(2), pacer: { beforeFile: async () => { paced++; } } });
    expect(paced).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/build.test.ts` → FAIL, module missing. (The raw key for `B` is `raw/hilton-pbi/b/c1` because `safeKey` lower-cases.)

- [ ] **Step 3: Implement**

`kb-service/src/gen/build.ts`:
```ts
import type { SourceConfig } from '../config.ts';
import { gschema } from '../db/migrate.ts';
import type { Db } from '../db/pool.ts';
import { ingestFile, rawKey, type IngestDeps, type ItemInfo } from '../ingest/pipeline.ts';
import type { Pacer } from '../sync/pacer.ts';

export interface BuildDeps {
  db: Db; sources: SourceConfig[]; from: IngestDeps; to: IngestDeps; pacer?: Pacer;
  onProgress?(done: number, total: number): Promise<void> | void;
}

interface DocRow {
  source_id: string; drive_item_id: string; parent_id: string | null; path: string; name: string; web_url: string | null;
  mime: string | null; size: string | null; ctag: string | null; etag: string | null; content_hash: string | null; modified_at: Date | null;
}

const itemFrom = (r: DocRow): ItemInfo => ({
  sourceId: r.source_id, driveItemId: r.drive_item_id, parentId: r.parent_id, name: r.name, folders: r.path.split('/').filter(Boolean),
  webUrl: r.web_url, mime: r.mime, size: Number(r.size ?? 0), ctag: r.ctag, etag: r.etag,
  modifiedAt: (r.modified_at ?? new Date()).toISOString(),
});

/**
 * Rebuilds `to` from the raw originals of `from`'s documents. A document `to` already has was written
 * by sync fan-out after the build started, so it is newer and is left alone.
 */
export async function buildGeneration(d: BuildDeps): Promise<{ total: number; done: number; skipped: number; errors: number }> {
  const fs = gschema(d.from.gen), ts = gschema(d.to.gen);
  await d.db.query(`INSERT INTO ${ts}.folders SELECT * FROM ${fs}.folders ON CONFLICT DO NOTHING`);
  const docs: DocRow[] = (await d.db.query(
    `SELECT source_id, drive_item_id, parent_id, path, name, web_url, mime, size, ctag, etag, content_hash, modified_at FROM ${fs}.documents ORDER BY id`)).rows;
  const sources = new Map(d.sources.map(s => [s.id, s]));
  let done = 0, skipped = 0, errors = 0;
  for (const doc of docs) {
    const src = sources.get(doc.source_id);
    const exists = src && (await d.db.query(`SELECT 1 FROM ${ts}.documents WHERE source_id = $1 AND drive_item_id = $2`, [doc.source_id, doc.drive_item_id])).rowCount;
    if (!src || exists) skipped++;
    else {
      const tag = doc.ctag ?? doc.content_hash?.slice(0, 16);
      const bytes = tag ? await d.from.blob.get(rawKey(src.id, doc.drive_item_id, tag)).catch(() => null) : null;
      if (!bytes) errors++;
      else {
        await d.pacer?.beforeFile();
        if ((await ingestFile(d.to, src, itemFrom(doc), bytes)) === 'error') errors++;
      }
    }
    done++;
    if (done % 10 === 0 || done === docs.length) await d.onProgress?.(done, docs.length);
  }
  return { total: docs.length, done, skipped, errors };
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/build.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/gen/build.ts kb-service/test/build.test.ts
git commit -m "feat(kb): build lane that rebuilds a generation from archived originals"
```

---

### Task 5: Eval scoring module and the cutover gate

**Files:**
- Create: `kb-service/src/eval/score.ts`, `kb-service/src/gen/gate.ts`
- Modify: `kb-service/scripts/eval.ts` (import and re-export `scoreEval`/`EvalRow` from the module)
- Test: `kb-service/test/gate.test.ts`

**Interfaces:**
- Consumes: `runQuery`, `QueryDeps`, `QueryResult` (executor); `Db`, `gschema`.
- Produces: `interface EvalRow`; `scoreEval(rows, results)` (empty set → zeros, never NaN); `loadEvalRows(path): EvalRow[]`; `GATE_HIT5 = 0.85`; `evaluate(qd, rows, today?): Promise<{ hit5: number; mrr: number }>` (logs queries as user `eval`); `errorCount(db, gen): Promise<number>`; `gateVerdict({ candidate: { build_done, build_total, errors, hit5 }, live: { errors, hit5 }, questions }): { ready: boolean; reasons: string[] }`.

- [ ] **Step 1: Write the failing test**

`kb-service/test/gate.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { fallbackPlan } from '../src/query/planner.ts';
import { loadEvalRows, scoreEval } from '../src/eval/score.ts';
import { errorCount, evaluate, gateVerdict } from '../src/gen/gate.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db;
const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-gate-')));
const qd = () => ({ db, gen: 1, blob, embedder: new FakeEmbedder(), planner: { plan: async (q: string) => fallbackPlan(q) } });

beforeAll(async () => {
  db = await freshDb();
  await ingestFile(qd(), SRC, { sourceId: 'hilton-pbi', driveItemId: 'P', parentId: null, name: 'Pool report.txt', folders: ['Engineering'], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('The pool pump was replaced in August.'));
  await ingestFile(qd(), SRC, { sourceId: 'hilton-pbi', driveItemId: 'X', parentId: null, name: 'broken.xlsx', folders: [], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('not a zip'));
});
afterAll(async () => { await db.end(); });

describe('eval + gate', () => {
  it('scores an empty set as zero, not NaN', () => {
    expect(scoreEval([], [])).toEqual({ questions: 0, hit_at_5: 0, mrr: 0, numeric_accuracy: null });
  });

  it('loads JSONL questions, skipping blank lines', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kb-q-')), 'q.jsonl');
    writeFileSync(p, '{"question":"a","expected_files":["x"]}\n\n{"question":"b","expected_files":["y"]}\n');
    expect(loadEvalRows(p).map(r => r.question)).toEqual(['a', 'b']);
  });

  it('evaluates a generation and logs queries as the eval user', async () => {
    const s = await evaluate(qd(), [{ question: 'pool pump replaced', expected_files: ['Pool report.txt'] }]);
    expect(s).toEqual({ hit5: 1, mrr: 1 });
    expect((await db.query(`SELECT user_name FROM kb_meta.query_log ORDER BY id DESC LIMIT 1`)).rows[0].user_name).toBe('eval');
    expect(await errorCount(db, 1)).toBe(1);
  });

  it('passes only when every gate condition holds, and says why not', () => {
    const ok = { candidate: { build_done: 10, build_total: 10, errors: 1, hit5: 0.9 }, live: { errors: 1, hit5: 0.88 }, questions: 6 };
    expect(gateVerdict(ok)).toEqual({ ready: true, reasons: [] });
    expect(gateVerdict({ ...ok, candidate: { ...ok.candidate, build_done: 4 } }).reasons).toEqual(['Build is not finished (4 of 10 files).']);
    expect(gateVerdict({ ...ok, candidate: { ...ok.candidate, errors: 3 } }).reasons).toEqual(['More files failed than in the live generation (3 vs 1).']);
    expect(gateVerdict({ ...ok, candidate: { ...ok.candidate, hit5: 0.8 } }).reasons).toEqual(['Eval hit@5 0.80 is below 0.85.', 'Eval hit@5 0.80 is below the live generation (0.88).']);
    expect(gateVerdict({ ...ok, questions: 0 }).reasons).toEqual(['No eval questions configured (eval/questions.jsonl).']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/gate.test.ts` → FAIL, modules missing.

- [ ] **Step 3: Implement**

`kb-service/src/eval/score.ts`:
```ts
import { readFileSync } from 'node:fs';
import type { QueryResult } from '../query/executor.ts';

export interface EvalRow { question: string; expected_files: string[]; expected_value?: number }

export function loadEvalRows(path: string): EvalRow[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as EvalRow);
}

/** hit@5, MRR over the first 5 cited files, and numeric accuracy (±0.5%) where an expected value is given. */
export function scoreEval(rows: EvalRow[], results: QueryResult[]) {
  let hits = 0, rr = 0, numTotal = 0, numOk = 0;
  rows.forEach((row, i) => {
    const r = results[i];
    const cited = [...(r.passages ?? []).map(p => p.file), ...(r.files ?? []).map(f => f.file), ...(r.sources ?? []).map(s => s.file)].filter((f, j, a) => a.indexOf(f) === j).slice(0, 5);
    const rank = cited.findIndex(f => row.expected_files.includes(f));
    if (rank >= 0) { hits++; rr += 1 / (rank + 1); }
    if (row.expected_value !== undefined) {
      numTotal++;
      const got = r.answer_data?.reduce((s, x) => s + (typeof x.value === 'number' ? x.value : 0), 0);
      if (got !== undefined && Math.abs(got - row.expected_value) <= Math.abs(row.expected_value) * 0.005) numOk++;
    }
  });
  const n = rows.length || 1;
  return { questions: rows.length, hit_at_5: hits / n, mrr: rr / n, numeric_accuracy: numTotal ? numOk / numTotal : null };
}
```

In `kb-service/scripts/eval.ts`, delete the local `EvalRow` interface and `scoreEval` function, and add near the imports:
```ts
import { scoreEval, type EvalRow } from '../src/eval/score.ts';
export { scoreEval, type EvalRow };
```
(Leave the script's `--dry` and live branches unchanged; `npm run eval -- --dry` must still print `{ questions: 6, hit_at_5: 1, mrr: 1, numeric_accuracy: null }`.)

`kb-service/src/gen/gate.ts`:
```ts
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
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/gate.test.ts && npx tsc --noEmit && npm test && npm run eval -- --dry` → all PASS; dry eval prints the expected line.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/eval/score.ts kb-service/src/gen/gate.ts kb-service/scripts/eval.ts kb-service/test/gate.test.ts
git commit -m "feat(kb): reusable eval scoring and the cutover gate"
```

---

### Task 6: GenerationManager

**Files:**
- Create: `kb-service/src/gen/manager.ts`
- Test: `kb-service/test/manager.test.ts`

**Interfaces:**
- Consumes: registry (Task 1), `embedderFor` shape (Task 2), `buildGeneration` (Task 4), `evaluate`, `errorCount`, `gateVerdict` (Task 5), `Pacer`, `EvalRow`, `IngestDeps`, `QueryDeps`, `Planner`, `BlobStore`, `SourceConfig`.
- Produces:
```ts
interface ManagerDeps {
  db: Db; blob: BlobStore; planner: Planner; sources: SourceConfig[];
  embedderFor(model: string): Embedder; nextEmbedder(): Embedder;
  evalRows(): EvalRow[]; configVersion: string | null; pacer?: Pacer;
}
class GenerationManager {
  queryDeps(): Promise<QueryDeps>;                      // active generation + its embedder
  targets(): Promise<{ primary: IngestDeps; extra: IngestDeps[] }>;
  list(): Promise<Generation[]>;
  startBuild(): Promise<number>;                        // throws GenError if one is running
  waitForBuild(): Promise<void>;
  evaluate(id: number): Promise<{ ready: boolean; reasons: string[] }>;
  cutover(id: number): Promise<{ from: number; to: number }>;
  rollback(): Promise<{ from: number; to: number }>;
  discard(id: number): Promise<void>;
  dropExpired(): Promise<number[]>;
}
```

- [ ] **Step 1: Write the failing test**

`kb-service/test/manager.test.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { fallbackPlan } from '../src/query/planner.ts';
import { GenError, getGeneration } from '../src/gen/registry.ts';
import { GenerationManager } from '../src/gen/manager.ts';
import { freshDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, m: GenerationManager;
const fake = new FakeEmbedder();
const big = new FakeEmbedder(8); big.model = 'fake-hash-8';

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-mgr-')));
  await ingestFile({ db, gen: 1, blob, embedder: fake }, SRC, { sourceId: 'hilton-pbi', driveItemId: 'P', parentId: null, name: 'Pool report.txt', folders: ['Engineering'], webUrl: null, mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('The pool pump was replaced in August.'));
  m = new GenerationManager({
    db, blob, planner: { plan: async q => fallbackPlan(q) }, sources: [SRC],
    embedderFor: model => (model === 'fake-hash-8' ? big : fake), nextEmbedder: () => fake,
    evalRows: () => [{ question: 'pool pump replaced', expected_files: ['Pool report.txt'] }], configVersion: 'v2',
  });
});
afterAll(async () => { await db.end(); });

describe('GenerationManager', () => {
  it('builds, evaluates, marks ready, cuts over and rolls back', async () => {
    expect(await m.startBuild()).toBe(2);
    await expect(m.startBuild()).rejects.toThrow(GenError);
    await m.waitForBuild();
    expect(await getGeneration(db, 2)).toMatchObject({ status: 'ready', build_done: 1, build_total: 1, eval_hit5: 1, config_version: 'v2', note: null });
    expect((await m.targets()).extra.map(t => t.gen)).toEqual([2]);
    expect(await m.cutover(2)).toEqual({ from: 1, to: 2 });
    expect((await m.queryDeps()).gen).toBe(2);
    const t = await m.targets();
    expect([t.primary.gen, ...t.extra.map(x => x.gen)]).toEqual([2, 1]);
    expect(await m.rollback()).toEqual({ from: 2, to: 1 });
  });

  it('keeps a generation catching_up with reasons when the gate fails', async () => {
    m = new GenerationManager({ ...(m as unknown as { d: ConstructorParameters<typeof GenerationManager>[0] }).d, evalRows: () => [] });
    await m.startBuild();
    await m.waitForBuild();
    expect(await getGeneration(db, 2)).toMatchObject({ status: 'catching_up', note: 'No eval questions configured (eval/questions.jsonl).' });
  });

  it('marks a generation failed when the build throws', async () => {
    m = new GenerationManager({ ...(m as unknown as { d: ConstructorParameters<typeof GenerationManager>[0] }).d, sources: null as unknown as SourceConfig[] });
    await m.startBuild();
    await m.waitForBuild();
    expect((await getGeneration(db, 2))!.status).toBe('failed');
  });

  it('queries each generation with its own embedding model', async () => {
    await db.query(`UPDATE kb_meta.generations SET embedding_model = 'fake-hash-8' WHERE id = 1`);
    expect((await m.queryDeps()).embedder).toBe(big);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/manager.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`kb-service/src/gen/manager.ts`:
```ts
import type { SourceConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { EvalRow } from '../eval/score.ts';
import type { IngestDeps } from '../ingest/pipeline.ts';
import type { QueryDeps } from '../query/executor.ts';
import type { Planner } from '../query/planner.ts';
import type { BlobStore } from '../store/blob.ts';
import type { Pacer } from '../sync/pacer.ts';
import { buildGeneration } from './build.ts';
import { errorCount, evaluate as runEval, gateVerdict } from './gate.ts';
import {
  GenError, activeGeneration, createGeneration, cutover, discardGeneration, dropExpired, getGeneration,
  listGenerations, rollback, setGeneration, writableGenerations, type Generation,
} from './registry.ts';

export interface ManagerDeps {
  db: Db; blob: BlobStore; planner: Planner; sources: SourceConfig[];
  embedderFor(model: string): Embedder; nextEmbedder(): Embedder;
  evalRows(): EvalRow[]; configVersion: string | null; pacer?: Pacer;
}

export class GenerationManager {
  private building: Promise<void> | null = null;
  constructor(private d: ManagerDeps) {}

  private ingestDeps(g: Generation): IngestDeps {
    return { db: this.d.db, gen: g.id, blob: this.d.blob, embedder: this.d.embedderFor(g.embedding_model) };
  }

  private qd(g: Generation): QueryDeps {
    return { ...this.ingestDeps(g), planner: this.d.planner };
  }

  async queryDeps(): Promise<QueryDeps> { return this.qd(await activeGeneration(this.d.db)); }

  async targets(): Promise<{ primary: IngestDeps; extra: IngestDeps[] }> {
    const [primary, ...rest] = await writableGenerations(this.d.db);
    return { primary: this.ingestDeps(primary), extra: rest.map(g => this.ingestDeps(g)) };
  }

  list(): Promise<Generation[]> { return listGenerations(this.d.db); }

  async startBuild(): Promise<number> {
    if (this.building) throw new GenError('A build is already running.');
    const e = this.d.nextEmbedder();
    const id = await createGeneration(this.d.db, e.model, e.dim, this.d.configVersion);
    this.building = this.runBuild(id)
      .catch(err => setGeneration(this.d.db, id, { status: 'failed', note: String((err as Error).message).slice(0, 500) }))
      .finally(() => { this.building = null; });
    return id;
  }

  async waitForBuild(): Promise<void> { await this.building; }

  private async runBuild(id: number): Promise<void> {
    const live = await activeGeneration(this.d.db);
    const target = (await getGeneration(this.d.db, id))!;
    const r = await buildGeneration({
      db: this.d.db, sources: this.d.sources, from: this.ingestDeps(live), to: this.ingestDeps(target), pacer: this.d.pacer,
      onProgress: (done, total) => setGeneration(this.d.db, id, { build_done: done, build_total: total }),
    });
    await setGeneration(this.d.db, id, { status: 'catching_up', build_done: r.done, build_total: r.total });
    await this.evaluate(id);
  }

  /** Runs the eval on the candidate and the live generation and applies the gate. */
  async evaluate(id: number): Promise<{ ready: boolean; reasons: string[] }> {
    const cand = await getGeneration(this.d.db, id);
    if (!cand || !['catching_up', 'ready'].includes(cand.status)) throw new GenError(`Generation ${id} is not waiting for evaluation.`);
    const live = await activeGeneration(this.d.db);
    const rows = this.d.evalRows();
    const [c, l] = rows.length ? [await runEval(this.qd(cand), rows), await runEval(this.qd(live), rows)] : [{ hit5: 0, mrr: 0 }, { hit5: 0, mrr: 0 }];
    const verdict = gateVerdict({
      candidate: { build_done: cand.build_done, build_total: cand.build_total, errors: await errorCount(this.d.db, id), hit5: c.hit5 },
      live: { errors: await errorCount(this.d.db, live.id), hit5: l.hit5 },
      questions: rows.length,
    });
    await setGeneration(this.d.db, id, {
      eval_hit5: c.hit5, eval_mrr: c.mrr, status: verdict.ready ? 'ready' : 'catching_up', note: verdict.reasons.join(' ') || null,
    });
    return verdict;
  }

  cutover(id: number) { return cutover(this.d.db, id); }
  rollback() { return rollback(this.d.db); }
  discard(id: number) { return discardGeneration(this.d.db, id); }
  dropExpired() { return dropExpired(this.d.db); }
}
```
(The tests reach the private `d` field to clone deps; keep the constructor parameter named `d`.)

- [ ] **Step 4: Verify**

Run: `npx vitest run test/manager.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/gen/manager.ts kb-service/test/manager.test.ts
git commit -m "feat(kb): GenerationManager — build, evaluate, gate, cutover, rollback"
```

---

### Task 7: API — per-request generation, admin routes; service wiring

**Files:**
- Modify (rewrite): `kb-service/src/api/server.ts`
- Modify (rewrite): `kb-service/src/main.ts`
- Modify: `kb-service/src/config.ts` (`adminKeys`, `configVersion`, `evalFile`)
- Modify: `kb-service/test/api.test.ts`
- Modify: `kb-service/.env.example`, `deploy/kb.env.example` (add `KB_ADMIN_KEYS=`)

**Interfaces:**
- Consumes: `GenerationManager` (Task 6), `GenError`, `Generation`, `embedderFor` (Task 2), `LatencyPacer` (Task 3), `loadEvalRows` (Task 5), `scheduleSync` (Plan 2), `createEmbedder`, `createPlanner`.
- Produces: `interface GenAccess` (the GenerationManager method subset the API uses); `interface AppDeps { db; blob; apiKeys; adminKeys; sources; graph; syncNow; gens: GenAccess }`; routes `GET /v1/admin/generations`, `POST /v1/admin/generations` (202 `{ id }`), `POST /v1/admin/generations/:id/evaluate`, `DELETE /v1/admin/generations/:id`, `POST /v1/admin/cutover { generation }`, `POST /v1/admin/rollback`; `/v1/status` gains `generations`. `Env` gains `adminKeys: Map<string,string>`, `configVersion: string | null`, `evalFile: string`.

- [ ] **Step 1: Update the tests first**

In `kb-service/test/api.test.ts`:
1. Add imports: `import { GenError, type Generation } from '../src/gen/registry.ts';` and `import type { GenAccess } from '../src/api/server.ts';`.
2. Replace the `createApp({...})` call with:
```ts
  const qd = { db, gen: 1, blob, embedder: new FakeEmbedder(), planner: { plan: async (q: string) => fallbackPlan(q) } };
  const gen1 = { id: 1, status: 'active' } as Generation;
  const gens: GenAccess = {
    queryDeps: async () => qd,
    list: async () => [gen1],
    startBuild: async () => 2,
    evaluate: async () => ({ ready: false, reasons: ['Build is not finished (0 of 1 files).'] }),
    cutover: async id => { if (id !== 2) throw new GenError(`Generation ${id} is not ready (status active).`); return { from: 1, to: 2 }; },
    rollback: async () => { throw new GenError('Nothing to roll back to: no generation was retired in the last 7 days.'); },
    discard: async () => undefined,
  };
  const app = createApp({
    db, blob, apiKeys: new Map([['secret', 'owner']]), adminKeys: new Map([['admin-secret', 'owner-admin']]),
    sources: [SRC], graph: null, syncNow: async s => { synced.push(s); }, gens,
  });
```
3. In the `GET /v1/status` test, add `expect(st.generations).toEqual([{ id: 1, status: 'active' }]);`.
4. Add:
```ts
  it('admin routes need an admin key and map rule refusals to 409', async () => {
    const admin = { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/v1/admin/generations`, { headers: auth })).status).toBe(401);
    expect(await (await fetch(`${base}/v1/admin/generations`, { headers: admin })).json()).toEqual({ generations: [{ id: 1, status: 'active' }] });
    const b = await fetch(`${base}/v1/admin/generations`, { method: 'POST', headers: admin });
    expect([b.status, await b.json()]).toEqual([202, { id: 2 }]);
    expect(await (await fetch(`${base}/v1/admin/generations/2/evaluate`, { method: 'POST', headers: admin })).json()).toEqual({ ready: false, reasons: ['Build is not finished (0 of 1 files).'] });
    const bad = await fetch(`${base}/v1/admin/cutover`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: 1 }) });
    expect([bad.status, (await bad.json()).error]).toEqual([409, 'Generation 1 is not ready (status active).']);
    const ok = await fetch(`${base}/v1/admin/cutover`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: 2 }) });
    expect(await ok.json()).toEqual({ from: 1, to: 2 });
    expect((await fetch(`${base}/v1/admin/rollback`, { method: 'POST', headers: admin })).status).toBe(409);
    expect((await fetch(`${base}/v1/admin/cutover`, { method: 'POST', headers: admin, body: JSON.stringify({ generation: 'x' }) })).status).toBe(400);
  });

  it('admin keys can also use the query API', async () => {
    expect((await fetch(`${base}/v1/status`, { headers: { Authorization: 'Bearer admin-secret' } })).status).toBe(200);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/api.test.ts` → FAIL (createApp signature, no admin routes).

- [ ] **Step 3: Implement**

`kb-service/src/config.ts`: add to `Env`: `adminKeys: Map<string, string>; configVersion: string | null; evalFile: string;` and in `loadEnv()`'s returned object:
```ts
    adminKeys: parseKeys(e.KB_ADMIN_KEYS ?? ''),
    configVersion: e.KB_CONFIG_VERSION || null,
    evalFile: e.EVAL_FILE ?? 'eval/questions.jsonl',
```
Also update `kb-service/test/planner.test.ts`'s `env()` helper object to include `adminKeys: new Map(), configVersion: null, evalFile: 'eval/questions.jsonl',` so it still typechecks.

`kb-service/src/api/server.ts` (full file):
```ts
import express, { type NextFunction, type Request, type Response } from 'express';
import type { SourceConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { gschema } from '../db/migrate.ts';
import { GenError, type Generation } from '../gen/registry.ts';
import { runQuery, type QueryDeps } from '../query/executor.ts';
import type { Filter } from '../query/filter.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { BlobStore } from '../store/blob.ts';
import type { GraphLike } from '../sync/graph.ts';

export interface GenAccess {
  queryDeps(): Promise<QueryDeps>;
  list(): Promise<Generation[]>;
  startBuild(): Promise<number>;
  evaluate(id: number): Promise<{ ready: boolean; reasons: string[] }>;
  cutover(id: number): Promise<{ from: number; to: number }>;
  rollback(): Promise<{ from: number; to: number }>;
  discard(id: number): Promise<void>;
}

export interface AppDeps {
  db: Db; blob: BlobStore; apiKeys: Map<string, string>; adminKeys: Map<string, string>;
  sources: SourceConfig[]; graph: GraphLike | null; syncNow(sourceId?: string): Promise<void>; gens: GenAccess;
}

class BadRequest extends Error {}
const need = (v: unknown, name: string) => { if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`"${name}" must be a non-empty string`); return v.trim(); };
const intOf = (v: unknown, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new BadRequest(`"${name}" must be a generation number`); return n; };
const bearer = (req: Request) => /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1];

export function createApp(d: AppDeps) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  app.use('/v1/admin', (req: Request, res: Response, next: NextFunction) => {
    const user = d.adminKeys.get(bearer(req) ?? '');
    if (!user) { res.status(401).json({ error: 'An admin key is required' }); return; }
    res.locals.user = user;
    next();
  });

  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    const key = bearer(req) ?? '';
    const user = d.apiKeys.get(key) ?? d.adminKeys.get(key);
    if (!user) { res.status(401).json({ error: 'Missing or unknown API key' }); return; }
    res.locals.user = user;
    next();
  });

  app.post('/v1/query', async (req, res) => {
    const question = need(req.body?.question, 'question');
    res.json(await runQuery(await d.gens.queryDeps(), question, undefined, res.locals.user));
  });

  app.post('/v1/search', async (req, res) => {
    const filter = (req.body?.filter ?? { and: [] }) as Filter;
    const k = Math.min(Math.max(Number(req.body?.k ?? 8), 1), 30);
    const query = need(req.body?.query, 'query');
    const passages = await hybridSearch(await d.gens.queryDeps(), { filter, keywords: { must: [], should: [], not: [] }, semantic: query, k });
    res.json({ passages });
  });

  app.get('/v1/datasets', async (req, res) => {
    const s = gschema((await d.gens.queryDeps()).gen);
    const q = req.query as Record<string, string | undefined>;
    const params: unknown[] = [];
    const where = ['TRUE'];
    const add = (sql: string, v: string | undefined) => { if (v) { params.push(v); where.push(sql.replace('?', `$${params.length}`)); } };
    add('lower(x.dataset) = lower(?)', q.dataset);
    add('lower(x.hotel) = lower(?)', q.hotel);
    add('x.period_end >= ?::date', q.from);
    add('x.period_start <= ?::date', q.to);
    const r = await d.db.query(
      `SELECT x.id::int id, x.hotel, x.department, x.dataset, x.sheet, x.normalizer, x.period_start, x.period_end, x.row_count, x.columns, doc.name file, doc.web_url link
       FROM ${s}.datasets x JOIN ${s}.documents doc ON doc.id = x.document_id WHERE ${where.join(' AND ')} ORDER BY x.period_start LIMIT 200`, params);
    res.json({ datasets: r.rows });
  });

  app.get('/v1/datasets/:id/file', async (req, res) => {
    const s = gschema((await d.gens.queryDeps()).gen);
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? (await d.db.query(`SELECT blob_key FROM ${s}.datasets WHERE id = $1`, [id])).rows[0] : undefined;
    if (!row) { res.status(404).json({ error: 'No dataset with that id' }); return; }
    res.type('application/vnd.apache.parquet').sendFile(await d.blob.localPath(row.blob_key));
  });

  app.get('/v1/status', async (_req, res) => {
    const gen = (await d.gens.queryDeps()).gen;
    const s = gschema(gen);
    const counts = (await d.db.query(`SELECT source_id, status, count(*)::int n FROM ${s}.documents GROUP BY 1, 2`)).rows;
    const state = (await d.db.query('SELECT * FROM kb_meta.sync_state')).rows;
    const errors = (await d.db.query(`SELECT source_id, name, path, error FROM ${s}.documents WHERE status = 'error' ORDER BY id DESC LIMIT 10`)).rows;
    res.json({
      generation: gen,
      generations: await d.gens.list(),
      sources: d.sources.map(src => ({
        id: src.id, name: src.name, enabled: src.enabled,
        documents: Object.fromEntries(counts.filter(c => c.source_id === src.id).map(c => [c.status, c.n])),
        sync: state.find(x => x.source_id === src.id) ?? null,
        recent_errors: errors.filter(e => e.source_id === src.id),
      })),
    });
  });

  app.post('/v1/sync', (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source : undefined;
    if (source && !d.sources.some(x => x.id === source)) { res.status(400).json({ error: `Unknown source ${source}` }); return; }
    d.syncNow(source).catch(e => console.error('manual sync failed:', e));
    res.status(202).json({ started: true });
  });

  app.get('/v1/admin/generations', async (_req, res) => { res.json({ generations: await d.gens.list() }); });
  app.post('/v1/admin/generations', async (_req, res) => { res.status(202).json({ id: await d.gens.startBuild() }); });
  app.post('/v1/admin/generations/:id/evaluate', async (req, res) => { res.json(await d.gens.evaluate(intOf(req.params.id, 'id'))); });
  app.delete('/v1/admin/generations/:id', async (req, res) => { await d.gens.discard(intOf(req.params.id, 'id')); res.json({ discarded: true }); });
  app.post('/v1/admin/cutover', async (req, res) => { res.json(await d.gens.cutover(intOf(req.body?.generation, 'generation'))); });
  app.post('/v1/admin/rollback', async (_req, res) => { res.json(await d.gens.rollback()); });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) { res.status(400).json({ error: err.message }); return; }
    if (err instanceof GenError) { res.status(409).json({ error: err.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  });
  return app;
}
```

`kb-service/src/main.ts` (full file):
```ts
import { existsSync } from 'node:fs';
import { createApp } from './api/server.ts';
import { loadEnv, loadSources, upsertSources } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { embedderFor } from './embed/registry.ts';
import { loadEvalRows } from './eval/score.ts';
import { GenerationManager } from './gen/manager.ts';
import { createEmbedder, createPlanner } from './llm/factory.ts';
import { scheduleSync } from './schedule.ts';
import { LocalBlobStore } from './store/blob.ts';
import { GraphClient } from './sync/graph.ts';
import { LatencyPacer } from './sync/pacer.ts';
import { syncSource } from './sync/runner.ts';

const env = loadEnv();
if (!env.apiKeys.size) throw new Error('KB_API_KEYS is empty; set at least one name:key pair in .env');
const db = createPool(env.databaseUrl);
const next = createEmbedder(env);
await migrate(db, next.model, next.dim);
const sources = loadSources(env.sourcesFile);
await upsertSources(db, sources);
const graph = env.ms ? new GraphClient(env.ms) : null;
const blob = new LocalBlobStore(env.blobDir);
const planner = createPlanner(env);
const pacer = new LatencyPacer(db);
const gens = new GenerationManager({
  db, blob, planner, sources, pacer, configVersion: env.configVersion,
  embedderFor: model => embedderFor(model, env), nextEmbedder: () => next,
  evalRows: () => (existsSync(env.evalFile) ? loadEvalRows(env.evalFile) : []),
});
const active = (await gens.queryDeps());
console.log(`models: planner ${env.llm.provider}:${env.llm.model}; active generation ${active.gen} embeds with ${active.embedder.model}; next generation would use ${next.model}`);

let running: Promise<void> | null = null;
async function syncAll(only?: string) {
  if (!graph) { console.warn('Sync skipped: KB_MS_TENANT_ID / KB_MS_CLIENT_ID / KB_MS_CLIENT_SECRET are not set.'); return; }
  const { primary, extra } = await gens.targets();
  for (const src of sources.filter(x => x.enabled && (!only || x.id === only))) {
    try { console.log(`sync ${src.id}:`, await syncSource({ ...primary, graph, extra, pacer }, src)); }
    catch (e) { console.error(`sync ${src.id} failed:`, (e as Error).message); }
  }
}
/** One sync at a time; a request during a run waits for it instead of starting a second one. */
const syncNow = (only?: string) => (running ??= syncAll(only).finally(() => { running = null; }));

createApp({ db, blob, apiKeys: env.apiKeys, adminKeys: env.adminKeys, sources, graph, syncNow, gens })
  .listen(env.port, () => console.log(`kb-service on http://localhost:${env.port} (generation ${active.gen})`));
const runSync = () => void syncNow();
if (!scheduleSync(env.syncMinutes, runSync)) console.log('Scheduled sync is off (SYNC_MINUTES=0); POST /v1/sync triggers it.');
setInterval(() => { gens.dropExpired().then(ids => ids.length && console.log('dropped expired generations', ids)).catch(e => console.error('dropExpired failed:', e)); }, 24 * 60 * 60_000);
```

Add `KB_ADMIN_KEYS=` (with comment `# name:key pairs for /v1/admin (cutover, rollback, builds)`) to `kb-service/.env.example` and `deploy/kb.env.example`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/api.test.ts && npx tsc --noEmit && npm test` → all PASS (main.ts is covered by typecheck; do not start it).

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/api/server.ts kb-service/src/main.ts kb-service/src/config.ts kb-service/test/api.test.ts kb-service/test/planner.test.ts kb-service/.env.example deploy/kb.env.example
git commit -m "feat(kb): admin API for builds, gate, cutover and rollback; per-request active generation"
```

---

### Task 8: kb-test environment and deploy updates

**Files:**
- Create: `kb-service/config/sources.test.yaml`
- Modify: `deploy/docker-compose.yml` (service `kb-test`, profile `test`, volume `kbtestdata`)
- Modify: `deploy/Caddyfile` (site `test.kb.{$PUBLIC_HOST}`)
- Modify: `kb-service/scripts/do-deploy.ts` (`buildKbEnv` sets `KB_CONFIG_VERSION`; `remoteScript` creates `kb_test` and starts the test profile when enabled)
- Modify: `kb-service/test/do-deploy.test.ts`

**Interfaces:**
- Consumes: Plan 2's compose stack and deploy script.
- Produces: `buildKbEnv(src, n8nKey, configVersion?: string)`; `remoteScript()` additions; the `kb-test` service reachable at `https://test.kb.<host>` when `KB_TEST_ENABLED=1` is in `deploy/.env`.

- [ ] **Step 1: Update the tests first**

In `kb-service/test/do-deploy.test.ts`:
1. In the "builds kb.env" test, call `buildKbEnv(src, 'n8nkey', 'abc1234')` and add `expect(out.get('KB_CONFIG_VERSION')).toBe('abc1234');`.
2. In the remote script test, add:
```ts
    expect(s).toContain(`SELECT 1 FROM pg_database WHERE datname='kb_test'`);
    expect(s).toContain('createdb -U kb kb_test');
    expect(s).toContain('grep -q "^KB_TEST_ENABLED=1" deploy/.env');
    expect(s).toContain('--profile test up -d --build kb-test');
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/do-deploy.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`kb-service/config/sources.test.yaml`:
```yaml
# Test environment: a small folder the owner creates at the top of the same document library.
sources:
  - id: kb-test
    name: Jarvis KB Test
    business: Cicero Hospitality Group
    hotel: Jarvis KB Test
    drive_id: "b!jdzaTEakwE2NJPvDBZJWzXcFMv2TcyVKqI2w_qwcCh0Mdg0JeuLATaBfh4OH160j"
    root_path: Jarvis KB Test
    levels: [department, dataset]
    enabled: true
```

In `deploy/docker-compose.yml`, add this service after `kb` and add `kbtestdata: {}` under `volumes`:
```yaml
  kb-test:
    profiles: ["test"]
    build: ../kb-service
    restart: unless-stopped
    env_file: ./kb.env
    environment:
      DATABASE_URL: postgres://kb:${POSTGRES_PASSWORD}@db:5432/kb_test
      SOURCES_FILE: config/sources.test.yaml
      BLOB_DIR: /data/blobs
      HF_CACHE_DIR: /data/hf-cache
      SYNC_MINUTES: "5"
      PORT: "8790"
    volumes:
      - kbtestdata:/data
    depends_on:
      db:
        condition: service_healthy
```

Append to `deploy/Caddyfile`:
```
test.kb.{$PUBLIC_HOST} {
	reverse_proxy kb-test:8790
}
```

In `kb-service/scripts/do-deploy.ts`:
1. Change `buildKbEnv`'s signature to `export function buildKbEnv(src: Map<string, string>, n8nKey: string, configVersion?: string): string` and before the `return`, add `if (configVersion) out.set('KB_CONFIG_VERSION', configVersion);`.
2. In `remoteScript()`, replace the line `'bash deploy/n8n-setup.sh',` with:
```ts
    'dc="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"',
    `$dc exec -T db psql -U kb -tAc "SELECT 1 FROM pg_database WHERE datname='kb_test'" | grep -q 1 || $dc exec -T db createdb -U kb kb_test`,
    'if grep -q "^KB_TEST_ENABLED=1" deploy/.env; then $dc --profile test up -d --build kb-test; fi',
    'bash deploy/n8n-setup.sh',
```
3. In the script's main block, compute the version and pass it: `const version = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).toString().trim();` and call `buildKbEnv(parseEnv(...), secrets.n8nKey, version)`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/do-deploy.test.ts && npx tsc --noEmit && npm test` → PASS.
Then (from `deploy/`): `printf 'POSTGRES_PASSWORD=x\nPUBLIC_HOST=localhost\nKB_N8N_KEY=y\n' > .env && touch kb.env && docker compose --profile test config >/dev/null && echo compose-ok; rm .env kb.env` → `compose-ok`.

- [ ] **Step 5: Commit**

```bash
git add kb-service/config/sources.test.yaml deploy/docker-compose.yml deploy/Caddyfile kb-service/scripts/do-deploy.ts kb-service/test/do-deploy.test.ts
git commit -m "feat(deploy): opt-in kb-test environment and config version on every deploy"
```

---

### Task 9: Jarvis tools for generations, cutover and rollback

**Files:**
- Modify: `jarvis-app/server/agent/tools/kb.ts`
- Modify: `jarvis-app/server/agent/tools/kb.test.ts`
- Modify: `jarvis-app/server/agent/prompt.ts` (Knowledge_Base engine line)
- Modify: `jarvis-app/.env.example` (`KB_ADMIN_KEY=`)

**Interfaces:**
- Consumes: kb-service `/v1/admin/*` (Task 7).
- Produces: `kbAdmin(path, init)`; tools `kb_generations` (list), `kb_build` (start a rebuild), `kb_cutover({ generation })` (gated, risk `Irreversible`), `kb_rollback` (gated, risk `Irreversible`); all refuse with a clear message when `KB_ADMIN_KEY` is unset.

- [ ] **Step 1: Write the failing tests**

In `jarvis-app/server/agent/tools/kb.test.ts`:
1. In the fake server's request handler, add before the 404 branch:
```ts
      else if (req.url === '/v1/admin/generations' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ generations: [{ id: 1, status: 'active' }, { id: 2, status: 'ready', eval_hit5: 0.9 }] })); }
      else if (req.url === '/v1/admin/cutover') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ from: 1, to: 2 })); }
```
2. After `process.env.KB_API_KEY = 'secret';` add `process.env.KB_ADMIN_KEY = 'admin';`.
3. Add tests:
```ts
  it('admin calls use the admin key', async () => {
    const out = JSON.parse(await kb.kbGenerations());
    expect(out.generations[1]).toMatchObject({ id: 2, status: 'ready' });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/admin/generations', auth: 'Bearer admin' });
    expect(JSON.parse(await kb.kbCutover(2))).toEqual({ from: 1, to: 2 });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ generation: 2 });
  });

  it('cutover and rollback ask for approval first', async () => {
    const cut = kb.KB_TOOLS.find(t => t.def.name === 'kb_cutover')!;
    const roll = kb.KB_TOOLS.find(t => t.def.name === 'kb_rollback')!;
    const input = cut.parse({ generation: 2 });
    expect(await cut.gate!(input)).toMatchObject({ action: 'Switch the knowledge base to generation 2', risk: 'Irreversible' });
    expect(await roll.gate!(roll.parse({}))).toMatchObject({ action: 'Roll the knowledge base back to the previous generation', risk: 'Irreversible' });
    expect(cut.parse({ generation: 'two' })).toBe('"generation" must be a whole number');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `jarvis-app/`): `npx vitest run server/agent/tools/kb.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `jarvis-app/server/agent/tools/kb.ts`:
1. Generalize the request helper: change `async function kb(path, init)` to take a key: `async function kb(path: string, init: { method?: string; body?: unknown } = {}, key = process.env.KB_API_KEY): Promise<Response>`, using `'Bearer ' + key` in the header; keep its existing behavior when `key` is the default.
2. Add:
```ts
async function kbAdmin(path: string, init: { method?: string; body?: unknown } = {}): Promise<string> {
  if (!process.env.KB_ADMIN_KEY) throw new Error('Knowledge-base admin is not configured. Set KB_ADMIN_KEY in .env.');
  return JSON.stringify(await (await kb(path, init, process.env.KB_ADMIN_KEY)).json());
}
export const kbGenerations = () => kbAdmin('/v1/admin/generations');
export const kbBuild = () => kbAdmin('/v1/admin/generations', { method: 'POST' });
export const kbCutover = (generation: number) => kbAdmin('/v1/admin/cutover', { method: 'POST', body: { generation } });
export const kbRollback = () => kbAdmin('/v1/admin/rollback', { method: 'POST' });
```
3. Append to `KB_TOOLS`:
```ts
  tool<Record<string, never>>({
    def: {
      name: 'kb_generations',
      description: 'Knowledge_Base admin: list knowledge-base generations (active, candidate being built or ready, retired), with build progress, eval hit@5 and gate notes.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: parser(() => ({})),
    step: () => ({ kind: 'memory', text: 'Checked knowledge-base generations' }),
    run: () => kbGenerations(),
  }),
  tool<Record<string, never>>({
    def: {
      name: 'kb_build',
      description: 'Knowledge_Base admin: start rebuilding the knowledge base into a new generation (after a rule change such as chunking, parsing or the embedding model). The live generation keeps answering; check progress with kb_generations.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: parser(() => ({})),
    step: () => ({ kind: 'memory', text: 'Started a knowledge-base rebuild' }),
    run: () => kbBuild(),
  }),
  tool<{ generation: number }>({
    def: {
      name: 'kb_cutover',
      description: 'Knowledge_Base admin: switch answers to a generation whose status is ready. Takes seconds; roll back with kb_rollback for 7 days.',
      input_schema: { type: 'object', properties: { generation: { type: 'number' } }, required: ['generation'] },
    },
    parse: parser(o => { const g = num(o, 'generation'); if (!Number.isInteger(g)) throw new Error('"generation" must be a whole number'); return { generation: g! }; }),
    step: i => ({ kind: 'memory', text: `Switched the knowledge base to generation ${i.generation}` }),
    gate: i => ({ action: `Switch the knowledge base to generation ${i.generation}`, detail: 'Jarvis will answer from the new generation right away. You can roll back for 7 days.', risk: 'Irreversible' }),
    run: i => kbCutover(i.generation),
  }),
  tool<Record<string, never>>({
    def: {
      name: 'kb_rollback',
      description: 'Knowledge_Base admin: switch answers back to the previously active generation (available for 7 days after a cutover).',
      input_schema: { type: 'object', properties: {} },
    },
    parse: parser(() => ({})),
    step: () => ({ kind: 'memory', text: 'Rolled the knowledge base back' }),
    gate: () => ({ action: 'Roll the knowledge base back to the previous generation', detail: 'Jarvis will answer from the previous generation right away.', risk: 'Irreversible' }),
    run: () => kbRollback(),
  }),
```

In `jarvis-app/server/agent/prompt.ts`, append to the Knowledge_Base engine line (item 7): ` Admin: kb_generations, kb_build, kb_cutover, kb_rollback — rebuild after rule changes, check the gate, and switch or roll back only when the user asks (both ask for approval).`

Append to `jarvis-app/.env.example`: `KB_ADMIN_KEY=` with comment `# Optional: an admin key from the service's KB_ADMIN_KEYS (cutover, rollback, rebuilds)`.

- [ ] **Step 4: Verify**

Run (from `jarvis-app/`): `npx vitest run && npx tsc -b` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add jarvis-app/server/agent/tools/kb.ts jarvis-app/server/agent/tools/kb.test.ts jarvis-app/server/agent/prompt.ts jarvis-app/.env.example
git commit -m "feat(jarvis): knowledge-base generations, rebuild, gated cutover and rollback tools"
```
