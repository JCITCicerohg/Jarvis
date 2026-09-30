# Jarvis Knowledge Base: SharePoint → DigitalOcean RAG — Design

Date: 2026-09-30 · Status: draft for review

## 1. Goal

Mirror selected SharePoint/OneDrive folders into a knowledge base on DigitalOcean so Jarvis can answer questions from company documents and data, with citations, staying in sync as files are added, changed, moved or deleted.

**Phase 1 scope:** one source, `CiceroHospitalityGroup` site → `Shared Documents/Hilton Palm Beach PBI`. Users: the owner and their executive, both with full access.

**Success criteria**
- A file added, edited, renamed/moved or deleted in the source folder is reflected in search within 10 minutes.
- Jarvis answers document questions ("What did the August 2024 Stay Experience report say about cleanliness?") with the source file, page and a SharePoint link.
- Jarvis answers numeric questions over recurring spreadsheets ("Total Amazon GL spend Jan–Aug 2026", "Labor hours trend for September") by SQL, not by reading chunks.
- A retrieval eval set (≈20 real questions with expected source files) scores hit@5 ≥ 85%.
- Adding another folder or hotel is a config row, not a code change.

**Non-goals (phase 1):** per-user/department access enforcement (data is tagged for it; enforcement is phase 2), GraphRAG entity/edge extraction, a separate router model, a web UI other than Jarvis's Apps modal status panel, write-back to SharePoint.

## 2. What we found in the source

`Hilton Palm Beach PBI/` holds Accounting (Budgets, Financials, GL's, Labor, Ottimate, Paycom, Toast), F&B (Inventories, Micros, Squirrel, Osteria, Banquets), Guest Scores (Stay Experience 2024–2026 monthly PDFs), Front Office, Housekeeping, Engineering, Inspections, Sales, plus loose trackers at the top level.

- Nesting is roughly **Hotel → Department → Dataset → Year → Month → file**, but files also sit loose at hotel and department level.
- Dates appear as: `07 - July`, `8 Aug`, `2026-09-01__…`, `01.2026 …`, `9.5-9.11`, `October 2025`, `Stay Experience 2024`.
- Mostly `.xlsx`; monthly PDFs; volume ≈ 30 daily labor files/month, one GL workbook/month (~15k rows).
- Spreadsheets are **report exports**, not tables: title rows, account-group header rows with detail beneath, blank spacer rows, sparse columns (e.g. GL Activity Detail).

## 3. Architecture

```
SharePoint / OneDrive  (sources table: drive + folder path per source)
      │  Microsoft Graph delta query, every 5 min (create / update / move / DELETE)
      ▼
n8n  — self-hosted, DO Droplet
  for each source: GET delta (from stored deltaLink) → filter to folder path
    file created/updated → POST /ingest {source, item metadata, downloadUrl}
    item deleted         → POST /delete {source, driveItemId}
    folder moved/renamed → POST /retag  {source, folderId}
    batch done           → POST /sync-state {source, deltaLink}
      │  private VPC, HMAC-signed requests
      ▼
kb-service  — TypeScript, Docker, same Droplet
  job queue (pg-boss) → download → store original in Spaces → parse (+OCR) →
  normalize spreadsheets → chunk → embed → one transaction per file in Postgres
  query API: /search, /datasets, /status   (HTTPS via Caddy, API key)
      ▼
DO Managed PostgreSQL 16 + pgvector        DO Spaces (bucket: jarvis-kb)
  sources · documents · chunks · datasets     raw/<source>/<driveItemId>/<cTag>
  sync_state · jobs (pg-boss)                  tidy/<source>/<dataset>/<period>.parquet
      ▲
      │  HTTPS + API key
Jarvis (owner's PC) — new tools kb_search, kb_datasets, kb_fetch_dataset → existing DuckDB engine
```

**Division of responsibility**
- **n8n** detects changes and dispatches. No parsing logic lives in n8n.
- **kb-service** owns all content logic and is the only writer to Postgres/Spaces. It is unit-testable.
- **Jarvis** never holds DB or Spaces credentials; it calls the query API. Future access control is enforced there, in one place.

## 4. Components

### 4.1 Sources (config)
`sources` table: `id`, `name`, `drive_id`, `root_item_id`, `root_path`, `business`, `hotel` (optional, when the root *is* a hotel), `level_map` (JSON, see 4.3), `enabled`, `created_at`. n8n reads enabled sources from `GET /sources` each cycle. A new source has no `sync_state` row, so its first delta call has no token and returns the full tree (backfill). Disabling a source stops sync; deleting it purges its documents, chunks and Spaces objects.

Phase 1 row: business `Cicero Hospitality Group`, hotel `Hilton Palm Beach PBI`, root `Shared Documents/Hilton Palm Beach PBI`.

### 4.2 Change detection (n8n workflow `kb-sync`)
1. Schedule trigger every 5 min; skip if the previous run is still going (single-concurrency).
2. For each enabled source: call `GET /drives/{drive_id}/root/delta` (or the stored `deltaLink`), following `@odata.nextLink` pages.
3. Keep items whose `parentReference.path` (or the kb-service's stored ancestor ids, for deletes, which omit path) falls under `root_path`.
4. Dispatch per item (below), with up to 4 in flight; retries with backoff on 5xx/429.
5. After every page is dispatched and acknowledged, `POST /sync-state` with the final `deltaLink`. A crash mid-run means the batch replays; all endpoints are idempotent.
6. HTTP 410 from Graph → `POST /resync {source}`: kb-service marks all source documents unseen, n8n runs a token-less delta, and documents still unseen afterwards are deleted.

Dispatch rules: `deleted` facet → `/delete`; folder with changed name/parent → `/retag`; file → `/ingest` (kb-service skips it if `cTag` is unchanged and only updates metadata if path changed).

### 4.3 Path → metadata
Every document gets: `business`, `hotel`, `department`, `dataset`, `period_start`, `period_end`, `period_grain` (day/week/month/year), and the raw `path_segments`.
- Default level map, relative to the source root: segment 1 = department, segment 2 = dataset; remaining folder segments and the file name are scanned for dates.
- Date parser handles, at minimum, every format in §2, including ranges (`9.5-9.11` → week, year inferred from the nearest year folder or modified date).
- Files loose at a level get only the levels above them (e.g. `Hilton Projects.xlsx` → department null, dataset "Hilton Projects").
- Unparseable dates fall back to `lastModifiedDateTime` with `period_grain = null`. Parsing never fails ingestion.
- Mapping changes re-run `/retag` over existing documents; no re-embedding needed.

### 4.4 Ingestion pipeline (kb-service)
Per job, keyed by `(source_id, drive_item_id)`:
1. Download via the pre-authenticated `downloadUrl` from delta (fallback: kb-service fetches it with its own app-only Graph token).
2. Hash content; if `content_hash` matches the stored one, update metadata only and stop.
3. Store the original in Spaces at `raw/<source>/<driveItemId>/<cTag>` (enables re-processing without re-downloading).
4. Parse by type:
   - **PDF**: text layer per page; pages with no text are OCR'd (`ocrmypdf`/Tesseract in the image).
   - **Images** (jpg/png/tiff): OCR.
   - **DOCX**: structured text with headings (`mammoth`). **PPTX**: per-slide text. **TXT/MD/CSV**: as-is.
   - **XLSX/XLS/CSV**: see 4.5.
   - Unsupported types: document row with `status = skipped`, no chunks.
5. Chunk (4.6), embed (4.7).
6. One transaction: delete the document's old chunks and dataset partitions, insert new ones, update the document row (`status = indexed`, `cTag`, `content_hash`, `indexed_at`).
7. Failure: `status = error`, `error` text saved, job retried up to 3 times with backoff, then left for the next sync cycle. One bad file never blocks others.

### 4.5 Spreadsheets
Two outputs per sheet:
- **Tidy data**: a normalizer turns the sheet into typed rows, written as Parquet to `tidy/<source>/<dataset>/<period>.parquet`, and registered in `datasets` (source, hotel, dataset, period, row count, column schema, Spaces key, document id).
  - **Named normalizers** for recurring reports, selected by dataset + header signature: `gl-activity-detail` (carries account #/name down onto detail rows, parses dates and amounts, drops title/spacer rows), `labor-summary`, `inventory`. Each has fixture-file tests built from real samples.
  - **Generic normalizer** for everything else: detect the header row (first row with ≥ 60% non-empty text cells followed by data rows), drop empty rows/columns, infer types.
- **Descriptor chunk**: one embedded text chunk per sheet: file, sheet, hotel/department/dataset/period, column names, row count, date range, 5 sample rows. This is how search finds the right dataset. Small sheets (≤ 200 rows, e.g. trackers) are also chunked as text rows so their content is directly searchable.

### 4.6 Chunking
- Split on structure first (headings, pages, slides), then pack to ~600 tokens (hard max 800) with ~15% overlap.
- Each chunk's embedded text is prefixed with a context header: `Hilton Palm Beach PBI › Guest Scores › Stay Experience › Aug 2024 › <section heading>`. The stored `text` keeps the raw content; `context` holds the header.
- Chunks store `page` (or slide/sheet) for citations.

### 4.7 Embeddings
OpenAI `text-embedding-3-small`, 1536 dims, batched. `chunks.embedding_model` is stored; changing models is a background re-embed from Spaces originals, not a re-sync.

### 4.8 Data model (Postgres)
- `sources` (4.1)
- `documents`: `id`, `source_id`, `drive_item_id` (unique per source), `parent_id`, `path`, `name`, `web_url`, `mime`, `size`, `ctag`, `etag`, `content_hash`, `modified_at`, metadata columns from 4.3, `status` (pending/indexed/skipped/error), `error`, `seen_in_resync`, `indexed_at`.
- `chunks`: `id`, `document_id` (FK, cascade), `ord`, `page`, `context`, `text`, `tokens`, `embedding vector(1536)`, `tsv tsvector` (generated from context + text), denormalized `hotel`, `department`, `dataset`, `period_start`, `embedding_model`. Indexes: HNSW on embedding (cosine), GIN on tsv, btree on (hotel, department, dataset, period_start).
- `datasets`: `id`, `document_id` (FK, cascade), `sheet`, `normalizer`, `hotel`, `dataset`, `period_start`, `period_end`, `row_count`, `columns` (JSON), `spaces_key`.
- `sync_state`: `source_id`, `delta_link`, `last_run_at`, `last_ok_at`, `items_last_run`.
- `folders`: `source_id`, `drive_item_id`, `parent_id`, `name` (lets deletes and folder moves be resolved without paths).

### 4.9 Query API (kb-service)
- `POST /search {query, filters?: {hotel, department, dataset, period_from, period_to, file_type}, k = 8}` → hybrid retrieval: top 40 by vector cosine + top 40 by `websearch_to_tsquery` rank, merged by Reciprocal Rank Fusion (k = 60), returns top k chunks with `text`, `context`, file name, page, `web_url`, period, score.
- `GET /datasets?hotel=&dataset=&from=&to=&q=` → matching tidy datasets with schemas.
- `POST /datasets/fetch {ids}` → short-lived presigned Spaces URLs for the Parquet files.
- `GET /status` → per source: last sync, document counts by status, recent errors.
- Ingestion endpoints (`/ingest`, `/delete`, `/retag`, `/resync`, `/sync-state`, `GET /sources`) accept only HMAC-signed requests from the VPC.

### 4.10 Jarvis integration
New tools in `server/agent/tools/`, available to the task runner and chat loop:
- `kb_search(query, filters?)` → cited chunks. The prompt tells Jarvis to cite file + page and link.
- `kb_datasets(query | filters)` → list of matching tidy datasets.
- `kb_fetch_dataset(ids)` → downloads the Parquet files to `data/kb/` and registers them as DuckDB views, so the existing `analytics_query` answers numeric questions across months.
- Apps modal: a "Knowledge Base" card showing `/status` (last sync, counts, errors), with an on/off switch like the other engines.
- Config: `KB_API_URL`, `KB_API_KEY` in `.env`.
- The existing SQLite memory stays as-is for personal facts and rules; `kb_search` is for company documents.

## 5. Security
- Azure app registration for kb-sync, app-only, **`Sites.Selected`** with a read grant on the CiceroHospitalityGroup site only. Each new source on another site/OneDrive needs its own grant (spike item 5).
- n8n ↔ kb-service over the Droplet's private network; requests HMAC-signed with `KB_INGEST_SECRET`, timestamped (5-min replay window).
- Query API behind Caddy with TLS; `KB_API_KEY` per client. Phase 2: keys map to allowed `(business, hotel, department)` scopes, applied as mandatory filters in every query.
- Postgres: separate roles for kb-service (read/write) and a read-only role; DB only reachable from the Droplet (trusted sources).
- Spaces bucket private; access only through presigned URLs with ≤ 15-min expiry.
- Secrets in the Droplet's env files, not in n8n workflow JSON.

## 6. Error handling and observability
- Document-level status and error text; failed docs retried each cycle, max 3 attempts per content version.
- Nightly reconciliation job: count files under each source via Graph vs. `documents` rows; mismatch → logged and shown in `/status`.
- n8n error workflow posts failures to the kb-service `/status` log (and optionally Teams).
- Structured JSON logs from kb-service; `/health` for Docker restart policy.

## 7. Testing
- **Unit:** path/date parser (every format in §2, ranges, loose files), each normalizer against real fixture files, generic header detection, chunker (sizes, overlap, context header), RRF merge, HMAC verification.
- **Integration:** kb-service + Postgres/pgvector in Docker Compose: ingest fixtures, update, move, delete, resync sweep; assert chunks/datasets/documents.
- **End-to-end:** against a test subfolder in SharePoint: add, edit, rename, move, delete a file; assert search reflects each within 10 minutes.
- **Retrieval eval:** `eval/questions.jsonl` (≈20 owner-supplied questions with expected files); script reports hit@5 and MRR. Run on every chunking/embedding change.

## 8. Phase 0 spike (before building, ~1 day)
Throwaway scripts against the real site to confirm:
1. Delta on the Shared Documents drive returns `@microsoft.graph.downloadUrl` for files, and what a folder move/rename emits for its children.
2. Deleted items can be mapped back to our folder tree by id (paths are omitted on deletes).
3. OCR quality on 3 real scans, if any exist in the folder.
4. The real date/folder variety across the whole Hilton PBI tree (full listing), to finalize the parser test table.
5. `Sites.Selected` grant works for the site, and whether a personal OneDrive (e.g. `it_cicerohg` `Hilton Reports/m3labor`) can be granted the same way.
6. Row/format samples of Labor Summary and Inventory to design their normalizers.

## 9. Infrastructure and rough cost
- Droplet (n8n + kb-service + Caddy), 4 GB RAM: ~$24/mo.
- DO Managed PostgreSQL 16, 2 GB (pgvector): ~$30/mo.
- Spaces: $5/mo (250 GB).
- Embeddings: initial Hilton backfill well under $5; ongoing cents/month.
Prices are approximate and to be confirmed at provisioning.

## 10. Phase 2 (not in this build)
Department/hotel access scopes on API keys; more hotels as sources; optional Graph change-notification webhook to cut latency below 5 min; optional reranker; optional GraphRAG entities if retrieval evals show a need.
