import type { SourceConfig } from '../config.ts';
import { gschema } from '../db/migrate.ts';
import { deleteItem, findDocument, ingestFile, upsertFolder, type IngestDeps } from '../ingest/pipeline.ts';
import { GraphError, type GraphItem, type GraphLike } from './graph.ts';

export { GraphError, type DeltaPage, type GraphItem, type GraphLike } from './graph.ts';

export const MAX_BYTES = 100 * 1024 * 1024;
export interface SyncSummary { indexed: number; unchanged: number; skipped: number; errors: number; deleted: number; folders: number; resync: boolean }

/** The item's own path segments relative to the source root, or null if it is outside the root. */
export function relSegments(src: SourceConfig, item: GraphItem): string[] | null {
  const raw = item.parentReference?.path;
  if (raw === undefined || item.name === undefined) return null;
  const after = raw.includes('root:') ? raw.slice(raw.indexOf('root:') + 5) : '';
  const parent = decodeURIComponent(after).split('/').filter(Boolean);
  const full = [...parent, item.name];
  const root = src.root_path.split('/').filter(Boolean);
  if (full.length < root.length || root.some((r, i) => full[i] !== r)) return null;
  return full.slice(root.length);
}

async function saveState(d: IngestDeps, sourceId: string, fields: { delta_link?: string | null; ok?: boolean; items?: number; error?: string | null }) {
  await d.db.query(
    `INSERT INTO kb_meta.sync_state (source_id, delta_link, last_run_at, last_ok_at, items_last_run, last_error)
     VALUES ($1, $2, now(), CASE WHEN $3 THEN now() END, $4, $5)
     ON CONFLICT (source_id) DO UPDATE SET
       delta_link = CASE WHEN $6 THEN $2 ELSE kb_meta.sync_state.delta_link END,
       last_run_at = now(), last_ok_at = CASE WHEN $3 THEN now() ELSE kb_meta.sync_state.last_ok_at END,
       items_last_run = $4, last_error = $5`,
    [sourceId, fields.delta_link ?? null, !!fields.ok, fields.items ?? 0, fields.error ?? null, fields.delta_link !== undefined],
  );
}

export async function syncSource(d: IngestDeps & { graph: GraphLike }, src: SourceConfig): Promise<SyncSummary> {
  const s = gschema(d.gen);
  const start = `https://graph.microsoft.com/v1.0/drives/${src.drive_id}/root/delta`;
  const state = (await d.db.query('SELECT delta_link FROM kb_meta.sync_state WHERE source_id = $1', [src.id])).rows[0];
  const sum: SyncSummary = { indexed: 0, unchanged: 0, skipped: 0, errors: 0, deleted: 0, folders: 0, resync: !state?.delta_link };
  let url: string | null = state?.delta_link ?? start;
  let items = 0;

  const beginResync = async () => {
    sum.resync = true;
    await d.db.query(`UPDATE ${s}.documents SET seen_in_resync = false WHERE source_id = $1`, [src.id]);
  };
  if (sum.resync) await beginResync();

  try {
    let deltaLink: string | undefined;
    while (url) {
      let page;
      try { page = await d.graph.delta(url); }
      catch (e) {
        if (e instanceof GraphError && e.status === 410 && url !== start) { await beginResync(); url = start; continue; }
        throw e;
      }
      items += page.value.length;
      const folders = page.value.filter(i => i.folder && !i.deleted);
      const files = page.value.filter(i => i.file && !i.deleted);
      const deletes = page.value.filter(i => i.deleted);
      for (const f of folders) {
        const rel = relSegments(src, f);
        if (!rel?.length) continue;
        await upsertFolder(d, src, { driveItemId: f.id, parentId: f.parentReference?.id ?? null, name: f.name!, folders: rel });
        sum.folders++;
      }
      for (const f of files) {
        const rel = relSegments(src, f);
        if (!rel) continue;
        const existing = await findDocument(d, src.id, f.id);
        if (existing && existing.ctag === f.cTag && existing.status === 'indexed') {
          await d.db.query(`UPDATE ${s}.documents SET seen_in_resync = true WHERE id = $1`, [existing.id]);
          sum.unchanged++;
          continue;
        }
        const info = {
          sourceId: src.id, driveItemId: f.id, parentId: f.parentReference?.id ?? null, name: f.name!, folders: rel.slice(0, -1),
          webUrl: f.webUrl ?? null, mime: f.file?.mimeType ?? null, size: f.size ?? 0, ctag: f.cTag ?? null, etag: f.eTag ?? null,
          modifiedAt: f.lastModifiedDateTime ?? new Date().toISOString(),
        };
        if ((f.size ?? 0) > MAX_BYTES) {
          console.warn(`skipped ${rel.join('/')}: larger than 100 MB`);
          sum.skipped++;
          continue;
        }
        let bytes: Buffer;
        try { bytes = await d.graph.download(src.drive_id, f); }
        catch { sum.errors++; continue; }
        const r = await ingestFile(d, src, info, bytes);
        if (r === 'error') sum.errors++; else sum[r]++;
      }
      for (const del of deletes) sum.deleted += await deleteItem(d, src.id, del.id);
      url = page['@odata.nextLink'] ?? null;
      deltaLink = page['@odata.deltaLink'] ?? deltaLink;
    }
    if (sum.resync) {
      const gone = (await d.db.query(`SELECT drive_item_id FROM ${s}.documents WHERE source_id = $1 AND NOT seen_in_resync`, [src.id])).rows;
      for (const g of gone) sum.deleted += await deleteItem(d, src.id, g.drive_item_id);
    }
    await saveState(d, src.id, { delta_link: deltaLink ?? null, ok: true, items });
    return sum;
  } catch (e) {
    await saveState(d, src.id, { error: (e as Error).message.slice(0, 1000), items });
    throw e;
  }
}
