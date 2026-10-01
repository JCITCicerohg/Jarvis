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
