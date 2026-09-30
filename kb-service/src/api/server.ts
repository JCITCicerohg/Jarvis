import express, { type NextFunction, type Request, type Response } from 'express';
import type { SourceConfig } from '../config.ts';
import { gschema } from '../db/migrate.ts';
import { runQuery, type QueryDeps } from '../query/executor.ts';
import type { Filter } from '../query/filter.ts';
import { hybridSearch } from '../search/hybrid.ts';
import type { GraphLike } from '../sync/graph.ts';

export interface AppDeps extends QueryDeps {
  apiKeys: Map<string, string>; sources: SourceConfig[]; graph: GraphLike | null;
  syncNow(sourceId?: string): Promise<void>;
}

class BadRequest extends Error {}
const need = (v: unknown, name: string) => { if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`"${name}" must be a non-empty string`); return v.trim(); };

export function createApp(d: AppDeps) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const s = gschema(d.gen);

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    const key = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1];
    const user = key ? d.apiKeys.get(key) : undefined;
    if (!user) { res.status(401).json({ error: 'Missing or unknown API key' }); return; }
    res.locals.user = user;
    next();
  });

  app.post('/v1/query', async (req, res) => {
    res.json(await runQuery(d, need(req.body?.question, 'question'), undefined, res.locals.user));
  });

  app.post('/v1/search', async (req, res) => {
    const filter = (req.body?.filter ?? { and: [] }) as Filter;
    const k = Math.min(Math.max(Number(req.body?.k ?? 8), 1), 30);
    const passages = await hybridSearch(d, { filter, keywords: { must: [], should: [], not: [] }, semantic: need(req.body?.query, 'query'), k });
    res.json({ passages });
  });

  app.get('/v1/datasets', async (req, res) => {
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
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? (await d.db.query(`SELECT blob_key FROM ${s}.datasets WHERE id = $1`, [id])).rows[0] : undefined;
    if (!row) { res.status(404).json({ error: 'No dataset with that id' }); return; }
    res.type('application/vnd.apache.parquet').sendFile(await d.blob.localPath(row.blob_key));
  });

  app.get('/v1/status', async (_req, res) => {
    const counts = (await d.db.query(`SELECT source_id, status, count(*)::int n FROM ${s}.documents GROUP BY 1, 2`)).rows;
    const state = (await d.db.query('SELECT * FROM kb_meta.sync_state')).rows;
    const errors = (await d.db.query(`SELECT source_id, name, path, error FROM ${s}.documents WHERE status = 'error' ORDER BY id DESC LIMIT 10`)).rows;
    res.json({
      generation: d.gen,
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

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) { res.status(400).json({ error: err.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  });
  return app;
}
