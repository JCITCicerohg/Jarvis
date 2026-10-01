import type { Db } from './pool.ts';

export const DEFAULT_EMBED_DIM = 384;
export const gschema = (n: number) => `kb_g${n}`;

const META = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS kb_meta;
CREATE TABLE IF NOT EXISTS kb_meta.settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS kb_meta.generations (
  id int PRIMARY KEY, status text NOT NULL, embedding_model text NOT NULL, embedding_dim int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), cutover_at timestamptz);
CREATE TABLE IF NOT EXISTS kb_meta.sources (
  id text PRIMARY KEY, name text NOT NULL, business text NOT NULL, hotel text,
  drive_id text NOT NULL, root_path text NOT NULL, levels text[] NOT NULL, enabled boolean NOT NULL);
CREATE TABLE IF NOT EXISTS kb_meta.sync_state (
  source_id text PRIMARY KEY REFERENCES kb_meta.sources(id) ON DELETE CASCADE,
  delta_link text, last_run_at timestamptz, last_ok_at timestamptz, items_last_run int NOT NULL DEFAULT 0, last_error text);
CREATE TABLE IF NOT EXISTS kb_meta.query_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), user_name text, question text NOT NULL,
  plan jsonb, generation int, latency_ms int, passages int, rows int, confidence text);
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS config_version text;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS eval_hit5 real;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS eval_mrr real;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS build_total int NOT NULL DEFAULT 0;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS build_done int NOT NULL DEFAULT 0;
ALTER TABLE kb_meta.generations ADD COLUMN IF NOT EXISTS note text;
`;

export function generationDdl(n: number, dim: number): string {
  const s = gschema(n);
  return `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.documents (
  id bigserial PRIMARY KEY, source_id text NOT NULL, drive_item_id text NOT NULL, parent_id text,
  path text NOT NULL, name text NOT NULL, web_url text, mime text, size bigint, ctag text, etag text,
  content_hash text, modified_at timestamptz, business text, hotel text, department text, dataset text,
  period_start date, period_end date, period_grain text, path_segments text[] NOT NULL DEFAULT '{}',
  file_type text, summary text, summary_embedding vector(${dim}),
  status text NOT NULL DEFAULT 'pending', error text, attempts int NOT NULL DEFAULT 0,
  seen_in_resync boolean NOT NULL DEFAULT true, indexed_at timestamptz,
  UNIQUE (source_id, drive_item_id));
CREATE TABLE IF NOT EXISTS ${s}.folders (
  source_id text NOT NULL, drive_item_id text NOT NULL, parent_id text, name text NOT NULL, path text NOT NULL,
  PRIMARY KEY (source_id, drive_item_id));
CREATE TABLE IF NOT EXISTS ${s}.sections (
  id bigserial PRIMARY KEY, document_id bigint NOT NULL REFERENCES ${s}.documents(id) ON DELETE CASCADE,
  ord int NOT NULL, page_from int, page_to int, heading text, text text NOT NULL);
CREATE TABLE IF NOT EXISTS ${s}.chunks (
  id bigserial PRIMARY KEY, section_id bigint NOT NULL REFERENCES ${s}.sections(id) ON DELETE CASCADE,
  document_id bigint NOT NULL REFERENCES ${s}.documents(id) ON DELETE CASCADE,
  ord int NOT NULL, page int, context text NOT NULL, text text NOT NULL, tokens int NOT NULL,
  embedding vector(${dim}) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', context || ' ' || text)) STORED,
  hotel text, department text, dataset text, period_start date, period_end date, file_type text);
CREATE INDEX IF NOT EXISTS ${s}_chunks_embedding ON ${s}.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS ${s}_chunks_tsv ON ${s}.chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS ${s}_chunks_meta ON ${s}.chunks (hotel, department, dataset, period_start);
CREATE TABLE IF NOT EXISTS ${s}.datasets (
  id bigserial PRIMARY KEY, document_id bigint NOT NULL REFERENCES ${s}.documents(id) ON DELETE CASCADE,
  sheet text NOT NULL, normalizer text NOT NULL, hotel text, department text, dataset text, file_type text,
  period_start date, period_end date, row_count int NOT NULL, columns jsonb NOT NULL, blob_key text NOT NULL);
CREATE INDEX IF NOT EXISTS ${s}_datasets_meta ON ${s}.datasets (hotel, dataset, period_start);
`;
}

/**
 * Creates or updates kb_meta and the active generation's schema. Returns the active generation.
 * Its embedding model is never changed here.
 */
export async function migrate(db: Db, embeddingModel: string, dim: number): Promise<number> {
  await db.query(META);
  const r = await db.query(`SELECT value FROM kb_meta.settings WHERE key = 'active_generation'`);
  if (!r.rowCount) {
    await db.query(generationDdl(1, dim));
    await db.query(`INSERT INTO kb_meta.generations (id, status, embedding_model, embedding_dim) VALUES (1, 'active', $1, $2) ON CONFLICT (id) DO NOTHING`, [embeddingModel, dim]);
    await db.query(`INSERT INTO kb_meta.settings (key, value) VALUES ('active_generation', '1') ON CONFLICT (key) DO NOTHING`);
    return 1;
  }
  const active = Number(r.rows[0].value);
  // The active generation keeps its own model; the configured embedder is used for the next generation (Plan 3).
  const g = (await db.query('SELECT embedding_dim FROM kb_meta.generations WHERE id = $1', [active])).rows[0];
  await db.query(generationDdl(active, g.embedding_dim));
  return active;
}
