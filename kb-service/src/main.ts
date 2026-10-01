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
