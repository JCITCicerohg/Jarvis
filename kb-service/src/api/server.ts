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
import type { JsonModel } from '../llm/json-model.ts';
import { loadCatalog } from '../query/catalog.ts';
import { extractCorrection } from '../corrections/extract.ts';
import { CorrectionError, createCorrection, decideCorrection, listCorrections, type Correction } from '../corrections/store.ts';

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
  db: Db; queryDb: Db; blob: BlobStore; apiKeys: Map<string, string>; adminKeys: Map<string, string>;
  sources: SourceConfig[]; graph: GraphLike | null; syncNow(sourceId?: string): Promise<void>; gens: GenAccess; extractor: JsonModel;
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
    res.locals.admin = d.adminKeys.has(key);
    next();
  });

  const qdeps = async () => ({ ...(await d.gens.queryDeps()), db: d.queryDb });

  app.post('/v1/query', async (req, res) => {
    const question = need(req.body?.question, 'question');
    res.json(await runQuery(await qdeps(), question, undefined, res.locals.user));
  });

  app.post('/v1/search', async (req, res) => {
    const filter = (req.body?.filter ?? { and: [] }) as Filter;
    const k = Math.min(Math.max(Number(req.body?.k ?? 8), 1), 30);
    const query = need(req.body?.query, 'query');
    const passages = await hybridSearch(await qdeps(), { filter, keywords: { must: [], should: [], not: [] }, semantic: query, k });
    res.json({ passages });
  });

  app.get('/v1/datasets', async (req, res) => {
    const qd = await qdeps();
    const s = gschema(qd.gen);
    const q = req.query as Record<string, string | undefined>;
    const params: unknown[] = [];
    const where = ['TRUE'];
    const add = (sql: string, v: string | undefined) => { if (v) { params.push(v); where.push(sql.replace('?', `$${params.length}`)); } };
    add('lower(x.dataset) = lower(?)', q.dataset);
    add('lower(x.hotel) = lower(?)', q.hotel);
    add('x.period_end >= ?::date', q.from);
    add('x.period_start <= ?::date', q.to);
    const r = await d.queryDb.query(
      `SELECT x.id::int id, x.hotel, x.department, x.dataset, x.sheet, x.normalizer, x.period_start, x.period_end, x.row_count, x.columns, doc.name file, doc.web_url link
       FROM ${s}.datasets x JOIN ${s}.documents doc ON doc.id = x.document_id WHERE ${where.join(' AND ')} ORDER BY x.period_start LIMIT 200`, params);
    res.json({ datasets: r.rows });
  });

  app.get('/v1/datasets/:id/file', async (req, res) => {
    const qd = await qdeps();
    const s = gschema(qd.gen);
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? (await d.queryDb.query(`SELECT blob_key FROM ${s}.datasets WHERE id = $1`, [id])).rows[0] : undefined;
    if (!row) { res.status(404).json({ error: 'No dataset with that id' }); return; }
    res.type('application/vnd.apache.parquet').sendFile(await d.blob.localPath(row.blob_key));
  });

  app.get('/v1/status', async (_req, res) => {
    const qd = await qdeps();
    const gen = qd.gen;
    const s = gschema(gen);
    const counts = (await d.queryDb.query(`SELECT source_id, status, count(*)::int n FROM ${s}.documents GROUP BY 1, 2`)).rows;
    const state = (await d.db.query('SELECT * FROM kb_meta.sync_state')).rows;
    const errors = (await d.queryDb.query(`SELECT source_id, name, path, error FROM ${s}.documents WHERE status = 'error' ORDER BY id DESC LIMIT 10`)).rows;
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

  app.get('/v1/admin/generations', async (_req, res) => { res.json({ generations: await d.gens.list() }); });
  app.post('/v1/admin/generations', async (_req, res) => { res.status(202).json({ id: await d.gens.startBuild() }); });
  app.post('/v1/admin/generations/:id/evaluate', async (req, res) => { res.json(await d.gens.evaluate(intOf(req.params.id, 'id'))); });
  app.delete('/v1/admin/generations/:id', async (req, res) => { await d.gens.discard(intOf(req.params.id, 'id')); res.json({ discarded: true }); });
  app.post('/v1/admin/cutover', async (req, res) => { res.json(await d.gens.cutover(intOf(req.body?.generation, 'generation'))); });
  app.post('/v1/admin/rollback', async (_req, res) => { res.json(await d.gens.rollback()); });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) { res.status(400).json({ error: err.message }); return; }
    if (err instanceof CorrectionError) { res.status(err.status).json({ error: err.message }); return; }
    if (err instanceof GenError) { res.status(409).json({ error: err.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  });
  return app;
}
