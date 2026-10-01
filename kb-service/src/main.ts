import { createApp } from './api/server.ts';
import { loadEnv, loadSources, upsertSources } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { createEmbedder, createPlanner } from './llm/factory.ts';
import { LocalBlobStore } from './store/blob.ts';
import { GraphClient } from './sync/graph.ts';
import { syncSource } from './sync/runner.ts';
import { scheduleSync } from './schedule.ts';

const env = loadEnv();
if (!env.apiKeys.size) throw new Error('KB_API_KEYS is empty; set at least one name:key pair in .env');
const db = createPool(env.databaseUrl);
const embedder = createEmbedder(env);
const gen = await migrate(db, embedder.model, embedder.dim);
const sources = loadSources(env.sourcesFile);
await upsertSources(db, sources);
const graph = env.ms ? new GraphClient(env.ms) : null;
const blob = new LocalBlobStore(env.blobDir);
const planner = createPlanner(env);
console.log(`models: planner ${env.llm.provider}:${env.llm.model}, embeddings ${embedder.model}`);

let running: Promise<void> | null = null;
async function syncAll(only?: string) {
  if (!graph) { console.warn('Sync skipped: KB_MS_TENANT_ID / KB_MS_CLIENT_ID / KB_MS_CLIENT_SECRET are not set.'); return; }
  for (const src of sources.filter(x => x.enabled && (!only || x.id === only))) {
    try { console.log(`sync ${src.id}:`, await syncSource({ db, gen, blob, embedder, graph }, src)); }
    catch (e) { console.error(`sync ${src.id} failed:`, (e as Error).message); }
  }
}
/** One sync at a time; a request during a run waits for it instead of starting a second one. */
const syncNow = (only?: string) => (running ??= syncAll(only).finally(() => { running = null; }));

createApp({ db, gen, blob, embedder, planner, apiKeys: env.apiKeys, sources, graph, syncNow })
  .listen(env.port, () => console.log(`kb-service on http://localhost:${env.port} (generation ${gen})`));
const runSync = () => void syncNow();
if (!scheduleSync(env.syncMinutes, runSync)) console.log('Scheduled sync is off (SYNC_MINUTES=0); POST /v1/sync triggers it.');
