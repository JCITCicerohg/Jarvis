import { createHash } from 'node:crypto';
import { chunkSections, type ParentChunk } from '../chunk/chunker.ts';
import type { SourceConfig } from '../config.ts';
import { gschema } from '../db/migrate.ts';
import { vec, withTx, type Db, type Tx } from '../db/pool.ts';
import type { Embedder } from '../embed/embedder.ts';
import { flagSuperseded } from '../corrections/store.ts';
import { parseFile } from '../parse/index.ts';
import type { TextSection } from '../parse/types.ts';
import { contextHeader, deriveMeta, type DocMeta } from '../paths/metadata.ts';
import { describeSheet, sheetRowSections } from '../sheets/describe.ts';
import { normalizeSheet } from '../sheets/normalize.ts';
import { writeParquet } from '../sheets/parquet.ts';
import type { TidyTable } from '../sheets/types.ts';
import { safeKey, type BlobStore } from '../store/blob.ts';

export interface IngestDeps { db: Db; gen: number; blob: BlobStore; embedder: Embedder }
export interface ItemInfo {
  sourceId: string; driveItemId: string; parentId: string | null; name: string; folders: string[];
  webUrl: string | null; mime: string | null; size: number; ctag: string | null; etag: string | null; modifiedAt: string;
}
type Status = 'indexed' | 'unchanged' | 'skipped' | 'error';
interface DatasetOut { sheet: string; normalizer: string; table: TidyTable; key: string }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Raw originals are shared by all generations; rebuilds read them back by this key. */
export const rawKey = (sourceId: string, driveItemId: string, tag: string) => safeKey('raw', sourceId, driveItemId, tag);

export async function findDocument(d: IngestDeps, sourceId: string, driveItemId: string) {
  const r = await d.db.query(`SELECT id, ctag, status FROM ${gschema(d.gen)}.documents WHERE source_id = $1 AND drive_item_id = $2`, [sourceId, driveItemId]);
  return (r.rows[0] as { id: number; ctag: string | null; status: string } | undefined) ?? null;
}

async function upsertDoc(q: Db | Tx, s: string, item: ItemInfo, meta: DocMeta, fields: { status: string; error?: string | null; hash?: string | null; bumpAttempts?: boolean }): Promise<number> {
  const r = await q.query(
    `INSERT INTO ${s}.documents (source_id, drive_item_id, parent_id, path, name, web_url, mime, size, ctag, etag, content_hash, modified_at,
       business, hotel, department, dataset, period_start, period_end, period_grain, path_segments, file_type, status, error, attempts, seen_in_resync, indexed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,true,CASE WHEN $22 = 'indexed' THEN now() END)
     ON CONFLICT (source_id, drive_item_id) DO UPDATE SET parent_id=$3, path=$4, name=$5, web_url=$6, mime=$7, size=$8, ctag=$9, etag=$10,
       content_hash=COALESCE($11, ${s}.documents.content_hash), modified_at=$12, business=$13, hotel=$14, department=$15, dataset=$16,
       period_start=$17, period_end=$18, period_grain=$19, path_segments=$20, file_type=$21, status=$22, error=$23,
       attempts=CASE WHEN $25 THEN ${s}.documents.attempts + 1 ELSE 0 END, seen_in_resync=true,
       indexed_at=CASE WHEN $22 = 'indexed' THEN now() ELSE ${s}.documents.indexed_at END
     RETURNING id`,
    [item.sourceId, item.driveItemId, item.parentId, item.folders.join('/'), item.name, item.webUrl, item.mime, item.size, item.ctag, item.etag,
      fields.hash ?? null, item.modifiedAt, meta.business, meta.hotel, meta.department, meta.dataset, meta.period.start, meta.period.end,
      meta.period.grain, meta.pathSegments, meta.fileType, fields.status, fields.error ?? null, fields.bumpAttempts ? 1 : 0, !!fields.bumpAttempts],
  );
  return Number(r.rows[0].id);
}

/** Turns a parsed file into text sections (for chunks) and tidy datasets (for SQL). */
async function build(d: IngestDeps, src: SourceConfig, item: ItemInfo, meta: DocMeta, bytes: Buffer) {
  const parsed = await parseFile(item.name, bytes);
  if (parsed.kind === 'unsupported') return { unsupported: parsed.reason } as const;
  const sections: TextSection[] = [];
  const datasets: DatasetOut[] = [];
  if (parsed.kind === 'text') sections.push(...parsed.sections);
  else {
    for (const sheet of parsed.sheets) {
      const n = normalizeSheet(sheet.rows);
      if (!n) continue;
      const context = contextHeader(meta, null);
      sections.push({ heading: `Sheet: ${sheet.name}`, page: null, text: describeSheet({ file: item.name, sheet: sheet.name, context, table: n.table }) });
      sections.push(...sheetRowSections(n.table, sheet.name));
      const key = safeKey('tidy', `g${d.gen}`, src.id, meta.dataset ?? 'misc', `${item.driveItemId}-${sheet.name}.parquet`);
      await writeParquet(n.table, await d.blob.localPath(key));
      datasets.push({ sheet: sheet.name, normalizer: n.normalizer, table: n.table, key });
    }
  }
  return { parents: chunkSections(sections), datasets } as const;
}

async function writeContent(tx: Tx, s: string, docId: number, meta: DocMeta, parents: ParentChunk[], embeddings: number[][], datasets: DatasetOut[]) {
  await tx.query(`DELETE FROM ${s}.sections WHERE document_id = $1`, [docId]);
  await tx.query(`DELETE FROM ${s}.datasets WHERE document_id = $1`, [docId]);
  let e = 0;
  for (const p of parents) {
    const sec = await tx.query(`INSERT INTO ${s}.sections (document_id, ord, page_from, page_to, heading, text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [docId, p.ord, p.pageFrom, p.pageTo, p.heading, p.text]);
    const context = contextHeader(meta, p.heading);
    for (const c of p.children) {
      await tx.query(
        `INSERT INTO ${s}.chunks (section_id, document_id, ord, page, context, text, tokens, embedding, hotel, department, dataset, period_start, period_end, file_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$12,$13,$14)`,
        [sec.rows[0].id, docId, c.ord, c.page, context, c.text, c.tokens, vec(embeddings[e++]), meta.hotel, meta.department, meta.dataset, meta.period.start, meta.period.end, meta.fileType],
      );
    }
  }
  for (const ds of datasets) {
    const period = ds.table.period ?? meta.period;
    await tx.query(
      `INSERT INTO ${s}.datasets (document_id, sheet, normalizer, hotel, department, dataset, file_type, period_start, period_end, row_count, columns, blob_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [docId, ds.sheet, ds.normalizer, meta.hotel, meta.department, meta.dataset, meta.fileType, period.start, period.end, ds.table.rows.length, JSON.stringify(ds.table.columns), ds.key],
    );
  }
}

export async function ingestFile(d: IngestDeps, src: SourceConfig, item: ItemInfo, bytes: Buffer): Promise<Status> {
  const s = gschema(d.gen);
  const meta = deriveMeta(src, item.folders, item.name, item.modifiedAt);
  const hash = sha256(bytes);
  const prev = (await d.db.query(`SELECT id, content_hash, status FROM ${s}.documents WHERE source_id = $1 AND drive_item_id = $2`, [item.sourceId, item.driveItemId])).rows[0];
  if (prev && prev.content_hash === hash && prev.status === 'indexed') {
    await d.blob.put(rawKey(src.id, item.driveItemId, item.ctag ?? hash.slice(0, 16)), bytes);
    await withTx(d.db, async tx => { await upsertDoc(tx, s, item, meta, { status: 'indexed', hash }); await retagChunks(tx, s, Number(prev.id), meta); });
    return 'unchanged';
  }
  try {
    await d.blob.put(rawKey(src.id, item.driveItemId, item.ctag ?? hash.slice(0, 16)), bytes);
    const built = await build(d, src, item, meta, bytes);
    if ('unsupported' in built) { await upsertDoc(d.db, s, item, meta, { status: 'skipped', error: built.unsupported, hash }); return 'skipped'; }
    const children = built.parents.flatMap(p => p.children.map(c => `${contextHeader(meta, p.heading)}\n${c.text}`));
    const embeddings = children.length ? await d.embedder.embed(children) : [];
    await withTx(d.db, async tx => {
      const id = await upsertDoc(tx, s, item, meta, { status: 'indexed', hash });
      await writeContent(tx, s, id, meta, built.parents, embeddings, built.datasets);
    });
    await flagSuperseded(d.db, { hotel: meta.hotel, dataset: meta.dataset, entities: [], modifiedAt: item.modifiedAt, driveItemId: item.driveItemId });
    return 'indexed';
  } catch (e) {
    await upsertDoc(d.db, s, item, meta, { status: 'error', error: (e as Error).message.slice(0, 1000), bumpAttempts: true });
    return 'error';
  }
}

/** Updates chunk context and denormalized tags after a metadata change (no re-embedding). */
async function retagChunks(tx: Tx, s: string, docId: number, meta: DocMeta) {
  const secs = (await tx.query(`SELECT id, heading FROM ${s}.sections WHERE document_id = $1`, [docId])).rows;
  for (const sec of secs) {
    await tx.query(
      `UPDATE ${s}.chunks SET context=$2, hotel=$3, department=$4, dataset=$5, period_start=$6, period_end=$7, file_type=$8 WHERE section_id=$1`,
      [sec.id, contextHeader(meta, sec.heading), meta.hotel, meta.department, meta.dataset, meta.period.start, meta.period.end, meta.fileType],
    );
  }
  await tx.query(`UPDATE ${s}.datasets SET hotel=$2, department=$3, dataset=$4 WHERE document_id=$1`, [docId, meta.hotel, meta.department, meta.dataset]);
}

/** Paths under `prefix` (the folder itself excluded): compares text, so "_" and "%" in names are safe. */
const under = (col: string, n: number) => `left(${col}, length($${n}) + 1) = $${n} || '/'`;

export async function deleteItem(d: IngestDeps, sourceId: string, driveItemId: string): Promise<number> {
  const s = gschema(d.gen);
  return withTx(d.db, async tx => {
    const doc = await tx.query(`DELETE FROM ${s}.documents WHERE source_id=$1 AND drive_item_id=$2 RETURNING id`, [sourceId, driveItemId]);
    if (doc.rowCount) return doc.rowCount;
    const f = (await tx.query(`DELETE FROM ${s}.folders WHERE source_id=$1 AND drive_item_id=$2 RETURNING path`, [sourceId, driveItemId])).rows[0];
    if (!f) return 0;
    await tx.query(`DELETE FROM ${s}.folders WHERE source_id=$1 AND ${under('path', 2)}`, [sourceId, f.path]);
    const r = await tx.query(`DELETE FROM ${s}.documents WHERE source_id=$1 AND (path=$2 OR ${under('path', 2)})`, [sourceId, f.path]);
    return r.rowCount ?? 0;
  });
}

export async function upsertFolder(d: IngestDeps, src: SourceConfig, f: { driveItemId: string; parentId: string | null; name: string; folders: string[] }): Promise<number> {
  const s = gschema(d.gen);
  const path = f.folders.join('/');
  return withTx(d.db, async tx => {
    const old = (await tx.query(`SELECT path FROM ${s}.folders WHERE source_id=$1 AND drive_item_id=$2`, [src.id, f.driveItemId])).rows[0];
    await tx.query(
      `INSERT INTO ${s}.folders (source_id, drive_item_id, parent_id, name, path) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_id, drive_item_id) DO UPDATE SET parent_id=$3, name=$4, path=$5`,
      [src.id, f.driveItemId, f.parentId, f.name, path],
    );
    if (!old || old.path === path) return 0;
    await tx.query(`UPDATE ${s}.folders SET path = $3 || substr(path, length($2) + 1) WHERE source_id=$1 AND ${under('path', 2)}`, [src.id, old.path, path]);
    const docs = (await tx.query(`SELECT id, name, path, modified_at FROM ${s}.documents WHERE source_id=$1 AND (path=$2 OR ${under('path', 2)})`, [src.id, old.path])).rows;
    for (const doc of docs) {
      const newPath = path + (doc.path as string).slice(old.path.length);
      const folders = newPath.split('/').filter(Boolean);
      const meta = deriveMeta(src, folders, doc.name, new Date(doc.modified_at).toISOString());
      await tx.query(
        `UPDATE ${s}.documents SET path=$2, path_segments=$3, department=$4, dataset=$5, period_start=$6, period_end=$7, period_grain=$8 WHERE id=$1`,
        [doc.id, newPath, folders, meta.department, meta.dataset, meta.period.start, meta.period.end, meta.period.grain],
      );
      await retagChunks(tx, s, Number(doc.id), meta);
    }
    return docs.length;
  });
}
