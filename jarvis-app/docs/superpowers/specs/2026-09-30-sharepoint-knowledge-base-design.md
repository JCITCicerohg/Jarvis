# Jarvis Knowledge Base: SharePoint → DigitalOcean RAG — Design

Date: 2026-09-30 · Status: draft for review (rev 2: environments/generations, query pipeline, indexing improvements)

## 1. Goal

Mirror selected SharePoint/OneDrive folders into a knowledge base on DigitalOcean so Jarvis can answer questions from company documents and data, with citations, staying in sync as files are added, changed, moved or deleted — without the live app ever being disrupted by folder changes, knowledge updates or rebuilds.

**Phase 1 scope:** one source, `CiceroHospitalityGroup` site → `Shared Documents/Hilton Palm Beach PBI`. Users: the owner and their executive, both with full access.

**Success criteria**
- A file added, edited, renamed/moved or deleted in the source folder is reflected in search within 10 minutes (fast lane).
- Bulk changes (a new folder of hundreds of files, a reorganisation) merge in gradually without slowing Jarvis's queries.
- Rule changes (chunking, embeddings, normalizers, folder mapping, schema) are built in the background and go live by a cutover of seconds, with instant rollback.
- Jarvis answers document questions ("What did the August 2024 Stay Experience report say about cleanliness?") with the source file, page and a SharePoint link.
- Jarvis answers numeric questions over recurring spreadsheets and reports ("Total Amazon GL spend Jan–Aug 2026 vs 2025", "Guest score trend 2024–2026") from computed data, and states any missing periods.
- A retrieval eval set (≈20 real questions with expected source files and answers) scores hit@5 ≥ 85%.
- Adding another folder or hotel is a config change, not a code change.

**Non-goals (phase 1):** per-user/department access enforcement (data is tagged and the filter hook exists; enforcement is phase 2), a GraphRAG node/edge graph (entity tags cover the need), a web UI other than Jarvis's Apps modal panel, write-back to SharePoint.

## 2. What we found in the source

`Hilton Palm Beach PBI/` holds Accounting (Budgets, Financials, GL's, Labor, Ottimate, Paycom, Toast), F&B (Inventories, Micros, Squirrel, Osteria, Banquets), Guest Scores (Stay Experience 2024–2026 monthly PDFs), Front Office, Housekeeping, Engineering, Inspections, Sales, plus loose trackers at the top level.

- Nesting is roughly **Hotel → Department → Dataset → Year → Month → file**, but files also sit loose at hotel and department level.
- Dates appear as: `07 - July`, `8 Aug`, `2026-09-01__…`, `01.2026 …`, `9.5-9.11`, `October 2025`, `Stay Experience 2024`.
- Mostly `.xlsx`; monthly PDFs; volume ≈ 30 daily labor files/month, one GL workbook/month (~15k rows).
- Spreadsheets are **report exports**, not tables: title rows, account-group header rows with detail beneath, blank spacer rows, sparse columns (e.g. GL Activity Detail).

## 3. Architecture

```
SharePoint / OneDrive  (sources from versioned config)
      │  Microsoft Graph delta query, every 5 min (create / update / move / DELETE)
      ▼
n8n  — self-hosted, DO Droplet
  for each source: GET delta → filter to folder path → POST change events → save deltaLink
      │  private VPC, HMAC-signed
      ▼
kb-service  — TypeScript, Docker (blue/green containers), same Droplet
  change events → fan-out to every generation accepting writes
  queues: fast lane · slow lane (throttled) · build lane (candidate generation)
  pipeline: download → archive original → parse/OCR → normalize → chunk → enrich → embed → atomic per-file write
  query API /v1: query (plan → execute → JSON) · search · datasets · status · admin (cutover/rollback)
      ▼
DO Managed PostgreSQL 16 + pgvector                    DO Spaces (bucket: jarvis-kb)
  kb_meta (active_generation, generations,                raw/<source>/<driveItemId>/<cTag>   (shared by all generations)
           sources, sync_state, query_log)                g<N>/tidy/<source>/<dataset>/<period>.parquet
  kb_g<N> schemas: documents, sections, chunks,
                   datasets, metrics, entities, folders
      ▲
      │  HTTPS + API key
Jarvis (owner's PC) — kb_query (main), kb_search, kb_fetch_dataset → formats the answer
Test environment: kb-test service + kb_test database + test/ Spaces prefix + test SharePoint folder, used by Jarvis's test instance (:8788)
```

**Division of responsibility**
- **n8n** detects changes and dispatches. No parsing logic lives in n8n.
- **kb-service** owns all content logic, the query planner/executor, and is the only writer to Postgres/Spaces.
- **Jarvis** never holds DB or Spaces credentials; it calls the query API and turns result JSON into the reply. Future access control is enforced in kb-service, in one place.

## 4. Environments and generations

### 4.1 Three environments
| | Test | Production build | Deployed (live) |
|---|---|---|---|
| What | Sandbox for code/config changes | A candidate generation built from real data | The active generation Jarvis reads |
| Runs as | `kb-test` container, `kb_test` DB, `test/` Spaces prefix, test SharePoint folder, own n8n workflow `kb-sync-test` | Background build inside production kb-service, lowest-priority queue | Production kb-service, `active_generation` pointer |
| Used by | Jarvis test instance (:8788, `KB_API_URL` → kb-test) | Nobody until cutover; eval runs against it | Jarvis live |

### 4.2 Generations
A generation is a complete, self-consistent version of the knowledge base: one Postgres schema `kb_g<N>` plus `g<N>/` in Spaces. `kb_meta.generations` records for each: id, status (building / catching_up / ready / active / retired), config version (git commit), kb-service version, embedding model, created/cutover/retired timestamps, eval scores. `kb_meta.active_generation` is the single pointer the query API reads per request.

### 4.3 Minor updates — straight to Deployed, slow-merged
Content-only changes: file add/edit/delete/move, new folders under an existing source, a new source using existing mapping rules.
- Applied to the active generation (and to any building/catching_up generation) via per-file atomic transactions: a query sees a file's old chunks or its new chunks, never a mix.
- **Fast lane:** normal edits; SLA ≤ 10 min.
- **Slow lane:** a sync batch over 200 items or 10% of the source's documents, and any new-source backfill. Throttled (default 20 files/min, configurable), and auto-pauses while query p95 latency exceeds 1.5 s. Knowledge appears progressively; no restart.

### 4.4 Major updates — build, gate, cutover
Rule changes: chunking/enrichment settings, embedding model, normalizers or extractors, folder level mapping, database schema, or any kb-service change that alters stored output.
1. **Test:** change is deployed to `kb-test` and verified (unit/integration tests, eval against test data, Jarvis test instance).
2. **Build:** `POST /v1/admin/generations` creates `kb_g<N+1>` and rebuilds it from the Spaces raw archive (no SharePoint re-download) in the build lane. Live keeps serving and receiving minor updates; those changes are also fanned out to the new generation, so it catches up.
3. **Gate:** the generation becomes `ready` only when its backlog is zero, every document is processed (errors ≤ live's), and eval hit@5 ≥ 85% and ≥ the live generation's score.
4. **Cutover (the "restart" moment):** owner approves in Jarvis's Apps modal (or `POST /v1/admin/cutover`); the pointer flips in one transaction. Jarvis needs no restart. In-flight queries finish on the old generation.
5. **Rollback:** the previous generation is retained 7 days in `retired` state, still receiving minor updates, so `POST /v1/admin/rollback` is instant and current. Older generations are dropped.

### 4.5 Code releases and config
- kb-service runs as blue/green containers behind Caddy; a release that does not change stored output (bug fix, API addition) swaps with zero downtime. A release that changes output is a major update (4.4).
- The query API is versioned (`/v1`); Jarvis's tools depend only on it.
- Config (`config/sources.yaml`, `config/levels.yaml`, `config/normalizers.yaml`, `config/indexing.yaml`) lives in git and is promoted Test → Production like code. At startup kb-service loads it into `kb_meta.sources`; each generation records the config commit that built it.
- Lane classification is automatic: config/code diff touches a rule → major; content only → minor (fast or slow by batch size).

## 5. Ingestion

### 5.1 Sources
`kb_meta.sources`: `id`, `name`, `drive_id`, `root_item_id`, `root_path`, `business`, `hotel` (optional), `level_map` ref, `enabled`. n8n reads enabled sources from `GET /v1/sources` each cycle. A new source has no `sync_state`, so its first delta call has no token and returns the full tree (backfill, slow lane). Disabling stops sync; removing a source from config purges its documents in all generations.

Phase 1 source: business `Cicero Hospitality Group`, hotel `Hilton Palm Beach PBI`, root `Shared Documents/Hilton Palm Beach PBI`.

### 5.2 Change detection (n8n workflow `kb-sync`)
1. Schedule trigger every 5 min, single concurrency.
2. For each source: `GET /drives/{drive_id}/root/delta` (or stored `deltaLink`), following `@odata.nextLink`.
3. Keep items under `root_path` (deletes, which omit paths, are resolved by kb-service against its `folders` table).
4. `POST /v1/changes {source, items[]}` in pages; kb-service classifies each item (file upsert, delete, folder move/rename) and enqueues it in the right lane for every generation accepting writes.
5. After all pages are acknowledged, `POST /v1/sync-state {source, deltaLink}`. A crash replays the batch; all handling is idempotent.
6. HTTP 410 → `POST /v1/resync {source}`: documents are marked unseen, a token-less delta runs, unseen documents are deleted.

### 5.3 Path → metadata
Every document gets `business`, `hotel`, `department`, `dataset`, `period_start`, `period_end`, `period_grain`, and raw `path_segments`.
- Default level map (relative to source root): segment 1 = department, segment 2 = dataset; remaining segments and the file name are scanned for dates.
- The date parser handles every format in §2, including ranges (`9.5-9.11` → week; year from the nearest year folder or modified date).
- Loose files get only the levels above them. Unparseable dates fall back to `lastModifiedDateTime` with `period_grain = null`. Parsing never fails ingestion.
- A folder move/rename re-tags the affected documents (no re-embedding).

### 5.4 Pipeline per file
Keyed by `(source_id, drive_item_id)`, per generation:
1. Download via delta's pre-authenticated `downloadUrl` (fallback: kb-service's own app-only Graph token). Skip if `content_hash` unchanged (metadata-only update).
2. Archive original to `raw/<source>/<driveItemId>/<cTag>`.
3. Parse: PDF text layer per page, OCR (`ocrmypdf`/Tesseract) for pages without text; images → OCR; DOCX (`mammoth`, headings kept); PPTX per slide; TXT/MD/CSV as-is; XLSX/XLS → 5.5. Tables in PDF/DOCX are converted to markdown and kept whole. Unsupported → `status = skipped`.
4. Normalize/extract (5.5, 5.6), chunk (6.1), enrich (6.2), embed (6.3).
5. One transaction: replace the document's chunks, datasets, metrics and entities; update the document row (`status = indexed`, `ctag`, `content_hash`, `indexed_at`).
6. Failure: `status = error` with message, 3 retries with backoff, then retried next cycle. One bad file never blocks others.

### 5.5 Spreadsheets
- **Tidy data:** a normalizer turns each sheet into typed rows written as Parquet to `g<N>/tidy/<source>/<dataset>/<period>.parquet`, registered in `datasets` (hotel, dataset, period, row count, column schema, Spaces key).
  - **Named normalizers** for recurring reports, selected by dataset + header signature: `gl-activity-detail` (carries account #/name onto detail rows, parses dates and amounts, drops title/spacer rows), `labor-summary`, `inventory`. Each is tested against real fixture files.
  - **Generic normalizer:** detect the header row (first row with ≥ 60% non-empty text cells followed by data rows), drop empty rows/columns, infer types.
- **Descriptor chunk** per sheet (file, sheet, hotel/department/dataset/period, columns, row count, date range, 5 sample rows) so search finds the right dataset. Sheets ≤ 200 rows (trackers) are also chunked as text rows.

### 5.6 Metric extraction from recurring PDFs
Named extractors turn recurring report PDFs into rows in `metrics` (`hotel`, `metric`, `period`, `value`, `unit`, `document_id`, `page`). First extractor: `stay-experience` (Guest Scores). Extraction uses Haiku 4.5 with a strict JSON schema, then validation (known metric names, numeric ranges); failures leave the PDF searchable as text and are reported in `/status`.

## 6. Indexing

### 6.1 Chunking (parent–child)
- Split on structure first (headings, pages, slides, tables), forming **parent sections** of ~1,000 tokens (max 1,500).
- Each parent is split into **child chunks** of ~200 tokens with ~15% overlap. Children are embedded and matched; results return the parent text for context.
- Tables are never split mid-row; a large table is split by row groups with the header repeated.

### 6.2 Enrichment
- **Context header** on every child: `Hilton Palm Beach PBI › Guest Scores › Stay Experience › Aug 2024 › <section heading>`.
- **Contextual sentence** (PDF/DOCX/PPTX only): Haiku 4.5 writes one sentence situating the chunk in its document, using prompt caching per document. Embedded and full-text indexed with the chunk.
- **Document summary:** one summary record per file (3–5 sentences + key topics), embedded, used for the first stage of two-stage retrieval.
- **Entity tags:** vendors, GL accounts, people, outlets (Osteria, Uno's, Squirrel, …) extracted into `entities` (normalized name, type, aliases) and linked to chunks and dataset rows; indexed for exact boolean filtering. Seeded from normalized spreadsheet columns (e.g. GL vendor names) and the entity list in Jarvis's existing memory.

### 6.3 Embeddings and indexes
- OpenAI `text-embedding-3-small`, 1536 dims, batched; model recorded per generation. Changing it is a major update.
- HNSW (cosine) on child embeddings and document summaries; GIN on `tsv` and entity tag arrays; btree on (hotel, department, dataset, period_start).
- Filtered vector search uses pgvector's iterative index scan if the DO-provided version supports it (spike item 7); otherwise the executor over-fetches and post-filters.
- Optional reranker over the top 40 candidates, enabled only if the eval shows a gain.

### 6.4 Data model (per generation schema `kb_g<N>`)
- `documents`: `id`, `source_id`, `drive_item_id` (unique per source), `parent_id`, `path`, `name`, `web_url`, `mime`, `size`, `ctag`, `etag`, `content_hash`, `modified_at`, metadata from 5.3, `summary`, `summary_embedding`, `status`, `error`, `seen_in_resync`, `indexed_at`.
- `sections` (parents): `id`, `document_id`, `ord`, `page_from`, `page_to`, `heading`, `text`.
- `chunks` (children): `id`, `section_id`, `document_id` (FK, cascade), `ord`, `page`, `context`, `context_sentence`, `text`, `tokens`, `embedding vector(1536)`, `tsv` (generated), denormalized `hotel`, `department`, `dataset`, `period_start`, `entity_ids int[]`.
- `datasets`: `id`, `document_id`, `sheet`, `normalizer`, `hotel`, `dataset`, `period_start`, `period_end`, `row_count`, `columns` (JSON), `spaces_key`.
- `metrics`: as in 5.6.
- `entities`: `id`, `name`, `type`, `aliases text[]`.
- `folders`: `source_id`, `drive_item_id`, `parent_id`, `name`.

Shared in `kb_meta` (tracks SharePoint, not content): `sync_state` (`source_id`, `delta_link`, `last_run_at`, `last_ok_at`, `items_last_run`), `sources`, `generations`, `query_log`.

## 7. Query pipeline: prompt → boolean plan → JSON → answer

### 7.1 Planner (kb-service, Haiku 4.5, strict JSON schema)
Input: the user's question, today's date, and a compact **catalog** from the active generation (hotels, departments, datasets with periods covered, metric names, top entities). Output: a `QueryPlan`:
```ts
type Filter =
  | { and: Filter[] } | { or: Filter[] } | { not: Filter }
  | { field: 'hotel' | 'department' | 'dataset' | 'file_type' | 'entity'; eq: string }
  | { field: 'period'; from: string; to: string };

interface QueryPlan {
  intent: 'doc_question' | 'find_files' | 'numeric' | 'numeric_compare' | 'trend' | 'metric_trend';
  filter: Filter;
  keywords: { must: string[]; should: string[]; not: string[] };
  semantic: string[];            // 1–3 rewritten search queries
  measure?: { source: 'dataset' | 'metric'; dataset_or_metric: string; agg: 'sum' | 'avg' | 'count' | 'min' | 'max';
              field?: string; group_by: ('year' | 'month' | 'week' | 'day' | 'entity' | 'account')[] };
  answer_shape: 'headline+table' | 'table' | 'answer+quotes' | 'file_list';
}
```
- Every filter value is validated against the catalog; unknown values are dropped and reported in the result's `notes` (never silently invented). Relative dates ("last month", "Q3", "YTD") are resolved to concrete ranges.
- Phase 2 hook: the caller's access scope is AND-ed onto `filter` after planning, server-side.
- If planning fails validation twice, fall back to a plain hybrid search with no filters, flagged in `notes`.

### 7.2 Executor (plain code, no LLM)
- `filter` → parameterized SQL `WHERE`; `keywords` → `to_tsquery` with `&`, `|`, `!`; `semantic` → vector search on child chunks.
- Retrieval: stage 1 matches document summaries (top 20 docs) under the filter; stage 2 runs hybrid search (vector top 40 + full-text top 40, RRF k = 60) over those documents' chunks; results are deduplicated to parent sections.
- Numeric intents: SQL built from `measure` over the dataset Parquet files (DuckDB inside kb-service) or the `metrics` table — generated from templates, never free-form model SQL.
- Coverage check: compares requested periods with periods present; missing ones go into `coverage.missing`.

### 7.3 Result JSON
```ts
interface QueryResult {
  plan: QueryPlan;
  answer_data?: Record<string, string | number>[];   // computed rows for numeric intents
  passages?: { text: string; heading: string; file: string; page?: number; link: string; period?: string; score: number }[];
  files?: { file: string; link: string; period?: string; summary: string }[];
  coverage: { requested?: string[]; missing: string[] };
  notes: string[];
  confidence: 'high' | 'medium' | 'low';
  generation: number;
}
```
Trimmed to a token budget (default ~3k tokens) before returning.

### 7.4 Formatter (Jarvis)
Jarvis's chat/task model receives only the `QueryResult` JSON and formats per `answer_shape`: headline number + table; period table for trends; answer + short quotes for documents; file list for finding files. Every answer ends with sources (file, page, link); missing coverage and dropped filters are stated plainly; nothing outside the JSON is asserted as fact.

## 8. API (kb-service `/v1`)
- `POST /query {question, k?}` → `QueryResult` (7).
- `POST /search {query, filter?, k = 8}` → passages (direct hybrid search, no planner).
- `GET /datasets?…` and `POST /datasets/fetch {ids}` → dataset list and presigned Parquet URLs (≤ 15 min).
- `GET /status` → per source and generation: last sync, counts by status, lane backlogs, recent errors, eval scores.
- Admin (API key with admin scope): `POST /admin/generations`, `GET /admin/generations`, `POST /admin/cutover {generation}`, `POST /admin/rollback`.
- Ingestion (HMAC, VPC only): `GET /sources`, `POST /changes`, `POST /sync-state`, `POST /resync`.

## 9. Jarvis integration
New tools in `server/agent/tools/kb.ts`, available to the task runner and chat loop:
- `kb_query(question)` — the default for company-document and data questions; returns `QueryResult`.
- `kb_search(query, filter?)` — direct passage search when Jarvis already knows what it wants.
- `kb_fetch_dataset(ids)` — downloads Parquet to `data/kb/` and registers DuckDB views, for follow-up analysis with the existing `analytics_query`.
- Prompt additions: when to use `kb_query` vs `memory_query`, the formatting rules in 7.4, citation format.
- Apps modal "Knowledge Base" card: `/status` summary, lane backlogs, generations list, and **Cut over** / **Roll back** buttons (both go through Jarvis's existing approval gate), plus an on/off switch.
- Config: `KB_API_URL`, `KB_API_KEY` (and `KB_ADMIN_KEY` for the modal's admin actions) in `.env`. The test instance uses kb-test's URL.
- The existing SQLite memory stays for personal facts and rules.

## 10. Security
- Azure app registration, app-only, **`Sites.Selected`** read grant on the CiceroHospitalityGroup site only; each new site/OneDrive needs its own grant (spike item 5).
- n8n ↔ kb-service over the Droplet's private network; HMAC with `KB_INGEST_SECRET`, timestamped, 5-min replay window.
- Query API behind Caddy (TLS); separate query and admin keys. Phase 2: keys map to `(business, hotel, department)` scopes enforced in the executor.
- Postgres: kb-service role (read/write), read-only role; DB reachable only from the Droplet. Planner output only ever reaches SQL through parameters/templates.
- Spaces private; presigned URLs ≤ 15 min. Secrets in Droplet env files, not n8n workflow JSON.

## 11. Error handling and observability
- Document-level status/errors; retries as in 5.4.
- Nightly reconciliation: Graph file count per source vs `documents` rows in the active generation; mismatch surfaced in `/status`.
- Query log (`kb_meta.query_log`): question, plan, generation, latency, result counts, confidence — used for eval growth and for the slow lane's latency guard.
- n8n error workflow reports failures to kb-service; structured JSON logs; `/health` for Docker restarts.

## 12. Testing
- **Unit:** date/path parser (every §2 format, ranges, loose files), each normalizer and extractor against real fixtures, header detection, parent–child chunker, table splitting, RRF, filter-tree → SQL compiler (including injection attempts), plan validation against a catalog, relative-date resolution, measure → SQL templates, HMAC.
- **Integration (Docker Compose, Postgres + pgvector):** ingest fixtures; update, move, delete, resync sweep; slow-lane throttling and pause; build a second generation, fan-out during catch-up, gate, cutover, rollback — asserting a concurrent query stream never errors or returns mixed generations.
- **Planner:** golden set of ~30 questions → expected plans (intent, filters, periods); run against the real model before each prompt/model change.
- **End-to-end:** test SharePoint folder: add, edit, rename, move, delete; assert search reflects each within 10 minutes.
- **Eval:** `eval/questions.jsonl` (≈20 owner-supplied questions with expected files and, for numeric ones, expected values); reports hit@5, MRR and numeric accuracy per generation. Part of the cutover gate.

## 13. Phase 0 spike (before building, ~1 day)
Throwaway scripts against the real site to confirm:
1. Delta on the Shared Documents drive returns `@microsoft.graph.downloadUrl`, and what a folder move/rename emits for its children.
2. Deleted items can be mapped to our folder tree by id.
3. OCR quality on 3 real scans, if any exist.
4. Full listing of the Hilton PBI tree to finalize the date/level parser test table.
5. `Sites.Selected` works for the site; whether a personal OneDrive (e.g. `Hilton Reports/m3labor`) can be granted the same way.
6. Samples of Labor Summary, Inventory and Stay Experience to design their normalizers/extractors.
7. pgvector version on DO Managed PostgreSQL 16 (iterative index scan support).

## 14. Infrastructure and rough cost
- Droplet (n8n + kb-service blue/green + kb-test + Caddy), 8 GB RAM: ~$48/mo.
- DO Managed PostgreSQL 16, 4 GB (room for two generations + test DB): ~$60/mo.
- Spaces: $5/mo (250 GB).
- Embeddings + Haiku enrichment/planning: initial Hilton backfill ~$5–15; ongoing a few dollars/month.
Prices approximate; confirm at provisioning.

## 15. Phase 2 (not in this build)
Department/hotel access scopes on API keys; more hotels as sources; Graph change-notification webhook for sub-5-minute latency; automatic cutover once the gate passes; more named normalizers/extractors as datasets recur.
