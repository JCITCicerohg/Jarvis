# KB Corrections (Plan 4 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis learns from corrections without ever touching official data: a correction is extracted into a structured fact with who/when, is company-wide by default (pending until the admin approves, visible to its author meanwhile) or personal on request, appears beside official results (never inside them) with contradictions called out, goes to review when a newer official file covers the same subject, and expires on schedule.

**Architecture:** `kb_meta.corrections` lives outside generations, so rebuilds and cutovers keep it. A Postgres role `kb_query` is used by every query-path endpoint: it can read official tables but only write `corrections` and `query_log` — enforced by the database, not by code. Corrections are embedded with the active generation's embedder and stored as `real[]` with the model name (re-embedded on demand if the model changed), so they work across generations of different dimensions. The executor adds a `corrections` section to Result JSON. The ingest pipeline flags overlapping corrections for review; a daily job expires them. Jarvis gets `kb_correct`, `kb_corrections` and `kb_decide_correction` tools.

**Tech Stack:** existing kb-service stack; Postgres roles and grants; the provider-neutral `JsonModel` (Haiku by default) for extraction.

**Spec:** `jarvis-app/docs/superpowers/specs/2026-09-30-sharepoint-knowledge-base-design.md` (rev 4) §8 (learning from corrections), §9 corrections routes, §10 Jarvis tools, §11 security.

## Global Constraints

- Official data (documents, sections, chunks, datasets, folders in every `kb_g*` schema) is never written by the query path; the `kb_query` role has only `SELECT` there, and `INSERT, UPDATE` only on `kb_meta.corrections` and `kb_meta.query_log`.
- Default scope is `global`: created `pending`, visible only to its author until an admin approves. `personal`: created `approved`, visible only to its author.
- Visible to a caller: approved global corrections + the caller's own pending/approved/needs_review corrections. Never others' personal or pending ones. Never `rejected` or `expired`.
- Corrections appear only in `QueryResult.corrections`; never in `passages`, `files` or `answer_data`.
- Supersession: when a document is indexed whose hotel matches and whose dataset or entities overlap an approved or pending correction, and which is newer (its `modified_at` is after the correction's `created_at`), the correction becomes `needs_review` with `superseded_by_item` = the document's drive item id.
- Time limits: personal corrections expire after 90 days; global corrections move to `needs_review` 180 days after approval.
- Author identity is the API key name (e.g. `owner`, `exec`); admins (keys in `KB_ADMIN_KEYS`) approve or reject global corrections; authors can retire or keep their own.
- Extraction uses the configured planner provider (`KB_LLM_PROVIDER`, Haiku by default) with a strict JSON schema; subject values are validated against the catalog like plan filters.
- Teams approval messages are deferred (no Teams credentials in n8n yet); approvals happen through Jarvis tools and the admin API. (Ruling, owner can revisit.)

## Review Focus

1. **A correction contradicting a document:** both are returned, the correction flagged `contradicts: <file>`, and the computed numbers unchanged. Test in Task 4.
2. **One user's personal or pending correction leaking to another user.** Visibility matrix test in Task 2.
3. **The query role trying to modify official data** (a bug or a crafted request): Postgres refuses. Test in Task 1.
4. **A correction made under generation 1, queried after cutover to a generation with another embedding model:** still found (re-embedded on demand). Test in Task 4.
5. **An ambiguous correction** ("that place slipped to Q4"): the API returns a clarifying question instead of storing a guess. Test in Task 3.

---

### Task 1: Corrections table and the `kb_query` database role

**Files:**
- Modify: `kb-service/src/db/migrate.ts` (corrections table; role + grants; grants in `generationDdl`)
- Modify: `kb-service/src/config.ts` (`queryDatabaseUrl`)
- Modify: `kb-service/test/helpers.ts` (`queryDb()` helper)
- Test: `kb-service/test/query-role.test.ts`

**Interfaces:**
- Produces: `migrate(db, model, dim, queryRolePassword = process.env.KB_QUERY_DB_PASSWORD ?? 'kbquery')` (extra optional arg); `queryUrl(databaseUrl, password): string` (same host/db, user `kb_query`); `Env.queryDatabaseUrl`; test helper `queryDb(): Db`.

- [ ] **Step 1: Write the failing test**

`kb-service/test/query-role.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.ts';
import { createGeneration } from '../src/gen/registry.ts';
import { queryUrl } from '../src/db/migrate.ts';
import { freshDb, queryDb } from './helpers.ts';

let db: Db, q: Db;
beforeAll(async () => { db = await freshDb(); await createGeneration(db, 'fake-hash', 384, null); q = queryDb(); });
afterAll(async () => { await q.end(); await db.end(); });

describe('kb_query role', () => {
  it('builds its connection URL from the main one', () => {
    expect(queryUrl('postgres://kb:kb@localhost:5433/kb_test', 's3cret')).toBe('postgres://kb_query:s3cret@localhost:5433/kb_test');
  });

  it('can read official tables in every generation, and write only corrections and the query log', async () => {
    expect((await q.query('SELECT count(*)::int n FROM kb_g1.documents')).rows[0].n).toBe(0);
    expect((await q.query('SELECT count(*)::int n FROM kb_g2.chunks')).rows[0].n).toBe(0);
    await q.query(`INSERT INTO kb_meta.corrections (text, original_message, author, scope, status) VALUES ('x', 'x', 'owner', 'global', 'pending')`);
    await q.query(`UPDATE kb_meta.corrections SET status = 'approved'`);
    await q.query(`INSERT INTO kb_meta.query_log (question) VALUES ('q')`);
  });

  it('is refused by Postgres when it tries to change official data', async () => {
    await expect(q.query(`DELETE FROM kb_g1.documents`)).rejects.toThrow(/permission denied/);
    await expect(q.query(`INSERT INTO kb_g2.documents (source_id, drive_item_id, path, name) VALUES ('s','d','p','n')`)).rejects.toThrow(/permission denied/);
    await expect(q.query(`UPDATE kb_meta.settings SET value = '2'`)).rejects.toThrow(/permission denied/);
    await expect(q.query(`DELETE FROM kb_meta.corrections`)).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `kb-service/`): `npx vitest run test/query-role.test.ts` → FAIL (no `queryUrl`, no helper, no table).

- [ ] **Step 3: Implement**

In `kb-service/src/db/migrate.ts`:
1. Append to `META` (after the generations ALTERs):
```sql
CREATE TABLE IF NOT EXISTS kb_meta.corrections (
  id bigserial PRIMARY KEY, text text NOT NULL, original_message text NOT NULL, author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL CHECK (scope IN ('global', 'personal')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'needs_review', 'expired')),
  hotel text, department text, dataset text, entities text[] NOT NULL DEFAULT '{}', period_start date, period_end date,
  embedding real[], embedding_model text,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  review_due_at timestamptz, expires_at timestamptz, decided_by text, decided_at timestamptz,
  superseded_by_item text, note text);
CREATE INDEX IF NOT EXISTS corrections_tsv ON kb_meta.corrections USING gin (tsv);
CREATE INDEX IF NOT EXISTS corrections_subject ON kb_meta.corrections (hotel, dataset, status);
```
2. Add:
```ts
/** Same server and database, connecting as the read-mostly kb_query role. */
export function queryUrl(databaseUrl: string, password: string): string {
  const u = new URL(databaseUrl);
  u.username = 'kb_query';
  u.password = password;
  return u.toString();
}

const roleSql = (password: string) => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kb_query') THEN CREATE ROLE kb_query LOGIN; END IF;
END $$;
ALTER ROLE kb_query PASSWORD '${password.replace(/'/g, "''")}';
GRANT USAGE ON SCHEMA kb_meta TO kb_query;
GRANT SELECT ON ALL TABLES IN SCHEMA kb_meta TO kb_query;
GRANT INSERT, UPDATE ON kb_meta.corrections, kb_meta.query_log TO kb_query;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA kb_meta TO kb_query;
`;
```
3. Append to the end of the string returned by `generationDdl(n, dim)`:
```sql
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kb_query') THEN
  EXECUTE 'GRANT USAGE ON SCHEMA ${s} TO kb_query';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO kb_query';
END IF; END $$;
```
4. Change `migrate`'s signature to `export async function migrate(db: Db, embeddingModel: string, dim: number, queryRolePassword = process.env.KB_QUERY_DB_PASSWORD ?? 'kbquery'): Promise<number>` and right after `await db.query(META);` run `await db.query(roleSql(queryRolePassword));`. Then, on both return paths, grants for every existing generation schema must exist; after the existing logic and before returning, run:
```ts
  const schemas = (await db.query(`SELECT schema_name s FROM information_schema.schemata WHERE schema_name LIKE 'kb\\_g%'`)).rows;
  for (const { s } of schemas) await db.query(`GRANT USAGE ON SCHEMA ${s} TO kb_query; GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO kb_query;`);
```
(restructure the function so both paths fall through to this block, then `return active`.)

In `kb-service/src/config.ts`: add `queryDatabaseUrl: string;` to `Env` and to `loadEnv()`'s object:
```ts
    queryDatabaseUrl: queryUrl(e.DATABASE_URL ?? 'postgres://kb:kb@localhost:5433/kb', e.KB_QUERY_DB_PASSWORD ?? 'kbquery'),
```
with `import { queryUrl } from './db/migrate.ts';`. Update `test/planner.test.ts`'s `env()` helper to include `queryDatabaseUrl: ''`.

In `kb-service/test/helpers.ts` add:
```ts
import { queryUrl } from '../src/db/migrate.ts';
/** A pool connected as the kb_query role (created by migrate with the default test password). */
export const queryDb = (): Db => createPool(queryUrl(TEST_DB, 'kbquery'));
```

Add to `kb-service/.env.example` and `deploy/kb.env.example`: `KB_QUERY_DB_PASSWORD=` with comment `# password for the read-mostly kb_query database role (any long random string)`.

- [ ] **Step 4: Verify**

Run: `npx vitest run test/query-role.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/db/migrate.ts kb-service/src/config.ts kb-service/test/helpers.ts kb-service/test/query-role.test.ts kb-service/test/planner.test.ts kb-service/.env.example deploy/kb.env.example
git commit -m "feat(kb): corrections table and a kb_query role that cannot modify official data"
```

---

### Task 2: Correction store — create, visibility, decisions, expiry, supersession

**Files:**
- Create: `kb-service/src/corrections/store.ts`
- Test: `kb-service/test/corrections-store.test.ts`

**Interfaces:**
- Produces:
```ts
type Scope = 'global' | 'personal';
type CStatus = 'pending' | 'approved' | 'rejected' | 'needs_review' | 'expired';
interface Correction { id: number; text: string; original_message: string; author: string; created_at: Date; scope: Scope; status: CStatus;
  hotel: string | null; department: string | null; dataset: string | null; entities: string[]; period_start: string | null; period_end: string | null;
  embedding: number[] | null; embedding_model: string | null; review_due_at: Date | null; expires_at: Date | null;
  decided_by: string | null; decided_at: Date | null; superseded_by_item: string | null; note: string | null }
interface NewCorrection { text: string; original_message: string; author: string; scope: Scope; hotel: string | null; department: string | null;
  dataset: string | null; entities: string[]; period_start: string | null; period_end: string | null; embedding: number[]; embedding_model: string }
PERSONAL_DAYS = 90; GLOBAL_REVIEW_DAYS = 180;
createCorrection(db, c: NewCorrection): Promise<Correction>
visibleCorrections(db, user: string): Promise<Correction[]>
listCorrections(db, opts: { user: string; admin: boolean; status?: CStatus }): Promise<Correction[]>
decideCorrection(db, id, decision: 'approve' | 'reject' | 'keep' | 'retire', by: string, admin: boolean): Promise<Correction>   // throws CorrectionError
updateEmbedding(db, id, embedding: number[], model: string): Promise<void>
expireCorrections(db): Promise<{ expired: number; review: number }>
flagSuperseded(db, doc: { hotel: string | null; dataset: string | null; entities: string[]; modifiedAt: string; driveItemId: string }): Promise<number>
class CorrectionError extends Error
```

- [ ] **Step 1: Write the failing test**

`kb-service/test/corrections-store.test.ts`:
```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/corrections-store.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`kb-service/src/corrections/store.ts`:
```ts
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
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/corrections-store.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/corrections/store.ts kb-service/test/corrections-store.test.ts
git commit -m "feat(kb): correction store with scope visibility, decisions, expiry and supersession"
```

---

### Task 3: Correction extraction

**Files:**
- Create: `kb-service/src/corrections/extract.ts`
- Modify: `kb-service/src/query/validate.ts` (export `canonical`)
- Test: `kb-service/test/corrections-extract.test.ts`

**Interfaces:**
- Consumes: `JsonModel` (llm/json-model.ts), `Catalog`, `canonical`, `normalizeRange`.
- Produces: `EXTRACT_SCHEMA`; `EXTRACT_SYSTEM`; `type Extracted = { kind: 'fact'; text: string; hotel: string | null; department: string | null; dataset: string | null; entities: string[]; period_start: string | null; period_end: string | null; notes: string[] } | { kind: 'clarify'; question: string }`; `extractCorrection(model: JsonModel, message: string, catalog: Catalog, today: string): Promise<Extracted>`.

- [ ] **Step 1: Write the failing test**

`kb-service/test/corrections-extract.test.ts`:
```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/corrections-extract.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

In `kb-service/src/query/validate.ts`, change `const canonical = …` to `export const canonical = …`.

`kb-service/src/corrections/extract.ts`:
```ts
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
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/corrections-extract.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/corrections/extract.ts kb-service/src/query/validate.ts kb-service/test/corrections-extract.test.ts
git commit -m "feat(kb): extract corrections into validated standalone facts or a clarifying question"
```

---

### Task 4: Corrections in query results

**Files:**
- Create: `kb-service/src/corrections/retrieve.ts`
- Modify: `kb-service/src/query/executor.ts` (`QueryResult.corrections`; `runQuery` calls `findCorrections` when a user is known)
- Test: `kb-service/test/corrections-retrieve.test.ts`

**Interfaces:**
- Consumes: `visibleCorrections`, `updateEmbedding`, `Correction` (Task 2); `Embedder`; `QueryPlan`.
- Produces: `interface ResultCorrection { text: string; author: string; created: string; scope: 'global' | 'personal'; status: 'approved' | 'pending' | 'needs_review'; contradicts?: string }`; `findCorrections(d: { db: Db; embedder: Embedder }, input: { user: string; question: string; plan: QueryPlan; cited: { file: string; hotel?: string | null; dataset?: string | null }[] }, k = 5): Promise<ResultCorrection[]>`; `QueryResult.corrections?: ResultCorrection[]`.

- [ ] **Step 1: Write the failing test**

`kb-service/test/corrections-retrieve.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import type { SourceConfig } from '../src/config.ts';
import { FakeEmbedder } from '../src/embed/embedder.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { ingestFile } from '../src/ingest/pipeline.ts';
import { createCorrection, decideCorrection } from '../src/corrections/store.ts';
import { findCorrections } from '../src/corrections/retrieve.ts';
import { runQuery } from '../src/query/executor.ts';
import type { PlannerOutputT } from '../src/query/plan.ts';
import { freshDb, queryDb } from './helpers.ts';

const SRC: SourceConfig = { id: 'hilton-pbi', name: 'Hilton Palm Beach PBI', business: 'Cicero Hospitality Group', hotel: 'Hilton Palm Beach PBI', drive_id: 'd', root_path: 'Hilton Palm Beach PBI', levels: ['department', 'dataset'], enabled: true };
let db: Db, q: Db;
const fake = new FakeEmbedder();
const blob = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-cr-')));
const plan = (p: Partial<PlannerOutputT> = {}): PlannerOutputT => ({ intent: 'doc_question', all: [], any_of_periods: [], exclude: [], keywords: { must: [], should: [], not: [] }, semantic: ['lobby renovation schedule'], measure: null, answer_shape: 'answer+quotes', ...p });

beforeAll(async () => {
  db = await freshDb();
  q = queryDb();
  await ingestFile({ db, gen: 1, blob, embedder: fake }, SRC, { sourceId: 'hilton-pbi', driveItemId: 'PR', parentId: null, name: 'Hilton Projects.txt', folders: [], webUrl: 'https://sp/PR', mime: null, size: 1, ctag: 'c', etag: 'e', modifiedAt: '2026-09-01T00:00:00Z' }, Buffer.from('Lobby renovation scheduled to finish in September 2026.'));
  const [emb] = await fake.embed(['The lobby renovation slipped to Q4 2026.']);
  const g = await createCorrection(q, { text: 'The lobby renovation slipped to Q4 2026.', original_message: 'lobby reno slipped to Q4', author: 'owner', scope: 'global', hotel: 'Hilton Palm Beach PBI', department: null, dataset: 'Hilton Projects', entities: ['Lobby renovation'], period_start: null, period_end: null, embedding: emb, embedding_model: 'fake-hash' });
  await decideCorrection(q, g.id, 'approve', 'owner-admin', true);
  const [e2] = await fake.embed(['Exec prefers pool reports weekly.']);
  await createCorrection(q, { text: 'Exec prefers pool reports weekly.', original_message: 'x', author: 'exec', scope: 'personal', hotel: null, department: null, dataset: null, entities: [], period_start: null, period_end: null, embedding: e2, embedding_model: 'fake-hash' });
});
afterAll(async () => { await q.end(); await db.end(); });

describe('corrections in results', () => {
  it('returns visible corrections beside official passages, flagging the contradiction', async () => {
    const r = await runQuery({ db: q, gen: 1, blob, embedder: fake, planner: { plan: async () => plan() } }, 'when does the lobby renovation finish?', '2026-10-01', 'owner');
    expect(r.passages![0].file).toBe('Hilton Projects.txt');
    expect(r.passages!.some(p => p.text.includes('slipped'))).toBe(false);
    expect(r.corrections).toEqual([{ text: 'The lobby renovation slipped to Q4 2026.', author: 'owner', created: expect.any(String), scope: 'global', status: 'approved', contradicts: 'Hilton Projects.txt' }]);
  });

  it("never shows another user's personal correction", async () => {
    const r = await findCorrections({ db: q, embedder: fake }, { user: 'owner', question: 'pool reports weekly', plan: { intent: 'doc_question', filter: { and: [] }, periods: [], keywords: { must: [], should: [], not: [] }, semantic: ['pool reports weekly'], measure: null, answer_shape: 'answer+quotes' }, cited: [] });
    expect(r.map(c => c.text)).not.toContain('Exec prefers pool reports weekly.');
  });

  it('re-embeds a correction stored with another model', async () => {
    const other = new FakeEmbedder(16); other.model = 'fake-16';
    const r = await findCorrections({ db: q, embedder: other }, { user: 'owner', question: 'lobby renovation slipped', plan: { intent: 'doc_question', filter: { and: [] }, periods: [], keywords: { must: [], should: [], not: [] }, semantic: ['lobby renovation slipped'], measure: null, answer_shape: 'answer+quotes' }, cited: [] });
    expect(r[0].text).toContain('lobby renovation');
    expect((await db.query(`SELECT embedding_model FROM kb_meta.corrections WHERE author = 'owner'`)).rows[0].embedding_model).toBe('fake-16');
  });

  it('is omitted when no user is known', async () => {
    const r = await runQuery({ db: q, gen: 1, blob, embedder: fake, planner: { plan: async () => plan() } }, 'lobby', '2026-10-01', null);
    expect(r.corrections).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/corrections-retrieve.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`kb-service/src/corrections/retrieve.ts`:
```ts
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
```

In `kb-service/src/query/executor.ts`:
1. Import `findCorrections` and `type ResultCorrection` from `../corrections/retrieve.ts`.
2. Add `corrections?: ResultCorrection[];` to `QueryResult` (after `sources`).
3. In `runQuery`, after the `if (plan.measure) {…} else {…}` block and before the confidence downgrade, add:
```ts
  if (user) {
    const cited = [...(result.passages ?? []), ...(result.files ?? []), ...(result.sources ?? [])].map(x => ({ file: x.file }));
    const corrections = await findCorrections(d, { user, question, plan, cited });
    if (corrections.length) result.corrections = corrections;
  }
```
(`contradicts` matching also uses the file name against the correction's dataset, so `Hilton Projects.txt` matches dataset `Hilton Projects`.)

- [ ] **Step 4: Verify**

Run: `npx vitest run test/corrections-retrieve.test.ts test/executor.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/corrections/retrieve.ts kb-service/src/query/executor.ts kb-service/test/corrections-retrieve.test.ts
git commit -m "feat(kb): return visible corrections beside official results, flagging contradictions"
```

---

### Task 5: Supersession on ingest and the daily expiry job

**Files:**
- Modify: `kb-service/src/ingest/pipeline.ts` (call `flagSuperseded` after a successful indexed write)
- Modify: `kb-service/src/main.ts` (daily `expireCorrections`)
- Test: add to `kb-service/test/ingest.test.ts`

**Interfaces:**
- Consumes: `flagSuperseded`, `expireCorrections` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `kb-service/test/ingest.test.ts`:
```ts
describe('supersession', () => {
  it('sends an overlapping correction to review when a newer official file arrives', async () => {
    const { createCorrection } = await import('../src/corrections/store.ts');
    const c = await createCorrection(db, { text: 'GL closes on the 5th.', original_message: 'x', author: 'owner', scope: 'global', hotel: 'Hilton Palm Beach PBI', department: 'Accounting', dataset: "GL's", entities: [], period_start: null, period_end: null, embedding: [1], embedding_model: 'fake-hash' });
    await ingestFile(d, SRC, item({ modifiedAt: new Date(Date.now() + 60_000).toISOString() }), await glBook());
    const row = (await db.query('SELECT status, superseded_by_item FROM kb_meta.corrections WHERE id = $1', [c.id])).rows[0];
    expect(row).toEqual({ status: 'needs_review', superseded_by_item: 'ITEM1' });
  });
});
```
Also add `kb_meta.corrections` to the `TRUNCATE` in that file's `beforeEach` (`TRUNCATE kb_g1.documents, kb_g1.folders, kb_meta.corrections RESTART IDENTITY CASCADE`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/ingest.test.ts` → the new test FAILS (status stays `pending`).

- [ ] **Step 3: Implement**

In `kb-service/src/ingest/pipeline.ts`, import `flagSuperseded` from `../corrections/store.ts`, and in `ingestFile` right after the successful `withTx(... writeContent ...)` call (before `return 'indexed';`) add:
```ts
    await flagSuperseded(d.db, { hotel: meta.hotel, dataset: meta.dataset, entities: [], modifiedAt: item.modifiedAt, driveItemId: item.driveItemId });
```

In `kb-service/src/main.ts`, import `expireCorrections` from `./corrections/store.ts` and add next to the `dropExpired` interval:
```ts
setInterval(() => { expireCorrections(db).then(r => (r.expired || r.review) && console.log('corrections expired/review', r)).catch(e => console.error('expireCorrections failed:', e)); }, 24 * 60 * 60_000);
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/ingest.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/ingest/pipeline.ts kb-service/src/main.ts kb-service/test/ingest.test.ts
git commit -m "feat(kb): flag corrections superseded by newer official files; daily expiry"
```

---

### Task 6: Corrections API and the query-role pool

**Files:**
- Modify: `kb-service/src/api/server.ts` (`queryDb` in deps; corrections routes; query endpoints use the query pool)
- Modify: `kb-service/src/main.ts` (second pool; extractor model)
- Modify: `kb-service/test/api.test.ts`

**Interfaces:**
- Consumes: `extractCorrection` (Task 3), store functions (Task 2), `loadCatalog`, `createJsonModel` (llm/factory.ts).
- Produces: `AppDeps.queryDb: Db`, `AppDeps.extractor: JsonModel`; routes `POST /v1/corrections { message, scope? }` → `201 { correction, notes }` or `200 { clarify }`; `GET /v1/corrections?status=`; `POST /v1/corrections/:id/decide { decision }`. Query-path routes (`query`, `search`, `datasets`, `status`, `corrections`) use `queryDb`; admin routes keep `db`.

- [ ] **Step 1: Update the tests first**

In `kb-service/test/api.test.ts`:
1. Import `queryDb` from `./helpers.ts`; create `const q = queryDb();` in `beforeAll` (after `freshDb`) and end it in `afterAll`.
2. In the `createApp({...})` call add `queryDb: q,` and an extractor fake:
```ts
    extractor: { name: 'fake', json: async (_s: string, user: string) => (user.includes('which place')
      ? { fact: '', clarify: 'Which hotel do you mean?', hotel: null, department: null, dataset: null, entities: [], period_from: null, period_to: null }
      : { fact: 'The pool pump costs 1,500 now.', clarify: null, hotel: 'Hilton Palm Beach PBI', department: null, dataset: 'Pool notes', entities: ['Pool pump'], period_from: null, period_to: null }) },
```
and change `qd` so its `db` is `q` (query role).
3. Add:
```ts
  it('records corrections (global by default), asks when unclear, and lets an admin approve', async () => {
    const c = await fetch(`${base}/v1/corrections`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'actually the pool pump costs 1500 now' }) });
    expect(c.status).toBe(201);
    const body = await c.json();
    expect(body.correction).toMatchObject({ text: 'The pool pump costs 1,500 now.', author: 'owner', scope: 'global', status: 'pending', dataset: 'Pool notes' });
    expect(body.correction).not.toHaveProperty('embedding');
    const unclear = await (await fetch(`${base}/v1/corrections`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'which place slipped' }) })).json();
    expect(unclear).toEqual({ clarify: 'Which hotel do you mean?' });
    const deny = await fetch(`${base}/v1/corrections/${body.correction.id}/decide`, { method: 'POST', headers: auth, body: JSON.stringify({ decision: 'approve' }) });
    expect(deny.status).toBe(403);
    const ok = await fetch(`${base}/v1/corrections/${body.correction.id}/decide`, { method: 'POST', headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    expect((await ok.json()).correction.status).toBe('approved');
    const list = await (await fetch(`${base}/v1/corrections?status=approved`, { headers: auth })).json();
    expect(list.corrections.map((x: { text: string }) => x.text)).toEqual(['The pool pump costs 1,500 now.']);
    expect((await fetch(`${base}/v1/corrections`, { method: 'POST', headers: auth, body: JSON.stringify({ message: 'x', scope: 'team' }) })).status).toBe(400);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/api.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `kb-service/src/api/server.ts`:
1. Imports: `import type { JsonModel } from '../llm/json-model.ts';`, `import { loadCatalog } from '../query/catalog.ts';`, `import { extractCorrection } from '../corrections/extract.ts';`, `import { CorrectionError, createCorrection, decideCorrection, listCorrections, type Correction } from '../corrections/store.ts';`.
2. Add `queryDb: Db; extractor: JsonModel;` to `AppDeps`.
3. Add a helper inside `createApp`: `const qdeps = async () => ({ ...(await d.gens.queryDeps()), db: d.queryDb });` and use `await qdeps()` instead of `await d.gens.queryDeps()` in the query, search, datasets, file and status routes; in those routes use `d.queryDb.query(...)` instead of `d.db.query(...)`.
4. Track admin in the general `/v1` middleware: set `res.locals.admin = d.adminKeys.has(key);`.
5. Add the routes (before the admin routes):
```ts
  const publicCorrection = ({ embedding, embedding_model, ...c }: Correction) => c;

  app.post('/v1/corrections', async (req, res) => {
    const message = need(req.body?.message, 'message');
    const scope = req.body?.scope ?? 'global';
    if (scope !== 'global' && scope !== 'personal') throw new BadRequest('"scope" must be "global" or "personal"');
    const qd = await qdeps();
    const ex = await extractCorrection(d.extractor, message, await loadCatalog(d.queryDb, qd.gen), new Date().toISOString().slice(0, 10));
    if (ex.kind === 'clarify') { res.json({ clarify: ex.question }); return; }
    const [embedding] = await qd.embedder.embed([ex.text]);
    const c = await createCorrection(d.queryDb, {
      text: ex.text, original_message: message, author: res.locals.user, scope, hotel: ex.hotel, department: ex.department, dataset: ex.dataset,
      entities: ex.entities, period_start: ex.period_start, period_end: ex.period_end, embedding, embedding_model: qd.embedder.model,
    });
    res.status(201).json({ correction: publicCorrection(c), notes: ex.notes });
  });

  app.get('/v1/corrections', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status as Correction['status'] : undefined;
    res.json({ corrections: (await listCorrections(d.queryDb, { user: res.locals.user, admin: res.locals.admin, status })).map(publicCorrection) });
  });

  app.post('/v1/corrections/:id/decide', async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'reject', 'keep', 'retire'].includes(decision)) throw new BadRequest('"decision" must be approve, reject, keep or retire');
    const c = await decideCorrection(d.queryDb, intOf(req.params.id, 'id'), decision, res.locals.user, res.locals.admin);
    res.json({ correction: publicCorrection(c) });
  });
```
6. In the error middleware add before the 500 branch: `if (err instanceof CorrectionError) { res.status(err.status).json({ error: err.message }); return; }`.

In `kb-service/src/main.ts`: create `const queryDb = createPool(env.queryDatabaseUrl);` after `migrate`, import `createJsonModel` from `./llm/factory.ts`, and pass `queryDb, extractor: createJsonModel(env)` to `createApp`. Also make the manager's query deps (used by eval) keep the main pool (unchanged).

- [ ] **Step 4: Verify**

Run: `npx vitest run test/api.test.ts && npx tsc --noEmit && npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add kb-service/src/api/server.ts kb-service/src/main.ts kb-service/test/api.test.ts
git commit -m "feat(kb): corrections API on the query role; query endpoints never use the write pool"
```

---

### Task 7: Jarvis correction tools and answer rules

**Files:**
- Modify: `jarvis-app/server/agent/tools/kb.ts`, `jarvis-app/server/agent/tools/kb.test.ts`
- Modify: `jarvis-app/server/chat.ts` (offer `kb_correct` in chat when configured)
- Modify: `jarvis-app/server/agent/prompt.ts`

**Interfaces:**
- Consumes: kb-service corrections routes (Task 6); `kb()` / `kbAdmin()` helpers (Plan 3 Task 9).
- Produces: `kbCorrect(message, scope?)`, `kbCorrections(status?)`, `kbDecideCorrection(id, decision)`; tools `kb_correct`, `kb_corrections`, `kb_decide_correction` (approve/reject use the admin key; keep/retire use the user key); chat tool `kb_correct`.

- [ ] **Step 1: Write the failing tests**

In `jarvis-app/server/agent/tools/kb.test.ts`, extend the fake server:
```ts
      else if (req.url === '/v1/corrections' && req.method === 'POST') { res.statusCode = 201; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ correction: { id: 7, text: 'The lobby renovation slipped to Q4 2026.', status: 'pending', scope: 'global' }, notes: [] })); }
      else if (req.url?.startsWith('/v1/corrections?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ corrections: [{ id: 7, status: 'pending' }] })); }
      else if (req.url === '/v1/corrections/7/decide') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ correction: { id: 7, status: 'approved' } })); }
```
and add:
```ts
  it('records a correction, global by default, and decides with the right key', async () => {
    const c = JSON.parse(await kb.kbCorrect('actually the lobby reno slipped to Q4'));
    expect(c.correction).toMatchObject({ id: 7, status: 'pending', scope: 'global' });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ message: 'actually the lobby reno slipped to Q4', scope: 'global' });
    expect(seen.at(-1)!.auth).toBe('Bearer secret');
    expect(JSON.parse(await kb.kbCorrections('pending')).corrections[0].id).toBe(7);
    expect(seen.at(-1)!.url).toBe('/v1/corrections?status=pending');
    await kb.kbDecideCorrection(7, 'approve');
    expect(seen.at(-1)!.auth).toBe('Bearer admin');
    await kb.kbDecideCorrection(7, 'retire');
    expect(seen.at(-1)!.auth).toBe('Bearer secret');
  });

  it('validates correction tool inputs', () => {
    const t = kb.KB_TOOLS.find(x => x.def.name === 'kb_decide_correction')!;
    expect(t.parse({ id: 7, decision: 'maybe' })).toBe('"decision" must be approve, reject, keep or retire');
    const c = kb.KB_TOOLS.find(x => x.def.name === 'kb_correct')!;
    expect(c.parse({ message: 'x', scope: 'team' })).toBe('"scope" must be global or personal');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `jarvis-app/`): `npx vitest run server/agent/tools/kb.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `jarvis-app/server/agent/tools/kb.ts` add:
```ts
export async function kbCorrect(message: string, scope: 'global' | 'personal' = 'global'): Promise<string> {
  return JSON.stringify(await (await kb('/v1/corrections', { method: 'POST', body: { message, scope } })).json());
}
export async function kbCorrections(status?: string): Promise<string> {
  return JSON.stringify(await (await kb('/v1/corrections' + (status ? `?status=${encodeURIComponent(status)}` : '?'))).json());
}
export async function kbDecideCorrection(id: number, decision: 'approve' | 'reject' | 'keep' | 'retire'): Promise<string> {
  const path = `/v1/corrections/${id}/decide`, init = { method: 'POST', body: { decision } };
  return decision === 'approve' || decision === 'reject' ? kbAdmin(path, init) : JSON.stringify(await (await kb(path, init)).json());
}
```
(`kbAdmin` is the Plan 3 helper; keep the same file.) Append to `KB_TOOLS`:
```ts
  tool<{ message: string; scope: 'global' | 'personal' }>({
    def: {
      name: 'kb_correct',
      description: 'Knowledge_Base: record the user\'s correction of a fact about company data (e.g. "the lobby renovation slipped to Q4"). Company-wide by default (pending approval, visible to the user right away); scope "personal" if they say it is just for them. Never changes official files. If the result has "clarify", ask the user that question.',
      input_schema: { type: 'object', properties: { message: { type: 'string', description: "The user's words" }, scope: { type: 'string', enum: ['global', 'personal'] } }, required: ['message'] },
    },
    parse: parser(o => {
      const scope = o.scope ?? 'global';
      if (scope !== 'global' && scope !== 'personal') throw new Error('"scope" must be global or personal');
      return { message: str(o, 'message')!, scope };
    }),
    step: i => ({ kind: 'memory', text: 'Saved a knowledge-base correction: ' + short(i.message, 80) }),
    run: i => kbCorrect(i.message, i.scope),
  }),
  tool<{ status?: string }>({
    def: {
      name: 'kb_corrections',
      description: 'Knowledge_Base: list corrections (filter by status: pending, approved, needs_review, rejected, expired). Admins see pending company-wide corrections awaiting approval.',
      input_schema: { type: 'object', properties: { status: { type: 'string' } } },
    },
    parse: parser(o => ({ status: str(o, 'status', false) })),
    step: () => ({ kind: 'memory', text: 'Checked knowledge-base corrections' }),
    run: i => kbCorrections(i.status),
  }),
  tool<{ id: number; decision: 'approve' | 'reject' | 'keep' | 'retire' }>({
    def: {
      name: 'kb_decide_correction',
      description: 'Knowledge_Base: approve or reject a pending company-wide correction (admin), or keep/retire one flagged needs_review. Only when the user decides.',
      input_schema: { type: 'object', properties: { id: { type: 'number' }, decision: { type: 'string', enum: ['approve', 'reject', 'keep', 'retire'] } }, required: ['id', 'decision'] },
    },
    parse: parser(o => {
      const id = num(o, 'id');
      if (!Number.isInteger(id)) throw new Error('"id" must be a whole number');
      const decision = o.decision;
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'keep' && decision !== 'retire') throw new Error('"decision" must be approve, reject, keep or retire');
      return { id: id!, decision };
    }),
    step: i => ({ kind: 'memory', text: `Correction ${i.id}: ${i.decision}` }),
    run: i => kbDecideCorrection(i.id, i.decision),
  }),
```

In `jarvis-app/server/chat.ts`: import `kbCorrect`; add a chat tool constant
```ts
const KB_CORRECT: Anthropic.Tool = {
  name: 'kb_correct',
  description: "Record the user's correction of a fact about company data (hotel reports, projects, figures). Company-wide by default, pending approval; scope 'personal' if they say it's just for them. If the result has 'clarify', ask that question.",
  input_schema: { type: 'object', properties: { message: { type: 'string' }, scope: { type: 'string', enum: ['global', 'personal'] } }, required: ['message'] },
};
```
add `...(kbConfigured() ? [KB_QUERY, KB_CORRECT] : [])` in place of the existing `...(kbConfigured() ? [KB_QUERY] : [])`, and a `runChatTool` case:
```ts
    case 'kb_correct': {
      const message = text(i.message);
      if (!message) return { text: 'message is required', isError: true };
      const scope = i.scope === 'personal' ? 'personal' : 'global';
      try { const r = await kbCorrect(message, scope); actions.push({ type: 'memory', text: 'Saved a correction: ' + message }); return { text: r }; }
      catch (e) { return { text: (e as Error).message, isError: true }; }
    }
```

In `jarvis-app/server/agent/prompt.ts`:
- Append to the Knowledge_Base engine line: ` Corrections: when the user corrects a fact about company data, call kb_correct (company-wide by default; "just for me" → personal) and confirm in one line ("Saved, pending approval company-wide."). Preferences about how to answer still go to memory_save_rule.`
- In `chatPrompt`, after the "Company documents and figures" rule, add: `- Corrections in results: when Result JSON has corrections, show them after the official answer as "Correction from <author>, <date>: <text>"; if one has "contradicts", say plainly that the file says otherwise and name the file; label pending ones "pending approval" and needs_review ones "may be outdated". Never fold a correction into a calculated number.`

- [ ] **Step 4: Verify**

Run (from `jarvis-app/`): `npx vitest run && npx tsc -b` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add jarvis-app/server/agent/tools/kb.ts jarvis-app/server/agent/tools/kb.test.ts jarvis-app/server/chat.ts jarvis-app/server/agent/prompt.ts
git commit -m "feat(jarvis): kb_correct, kb_corrections and kb_decide_correction with answer rules"
```
