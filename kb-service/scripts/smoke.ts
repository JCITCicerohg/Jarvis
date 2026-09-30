import { loadEnv, loadSources, upsertSources } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { createEmbedder, createPlanner } from '../src/llm/factory.ts';
import { runQuery } from '../src/query/executor.ts';
import { LocalBlobStore } from '../src/store/blob.ts';
import { GraphClient } from '../src/sync/graph.ts';
import { syncSource } from '../src/sync/runner.ts';

const env = loadEnv();
if (!env.ms) throw new Error('Set KB_MS_TENANT_ID, KB_MS_CLIENT_ID and KB_MS_CLIENT_SECRET in .env (see README "Microsoft 365 access").');
const db = createPool(env.databaseUrl);
const embedder = createEmbedder(env);
const gen = await migrate(db, embedder.model, embedder.dim);
const sources = loadSources(env.sourcesFile);
await upsertSources(db, sources);
const blob = new LocalBlobStore(env.blobDir);
const graph = new GraphClient(env.ms);

for (const src of sources.filter(s => s.enabled)) {
  const t0 = Date.now();
  console.log(`Syncing ${src.name}…`);
  console.log(await syncSource({ db, gen, blob, embedder, graph }, src), `${Math.round((Date.now() - t0) / 1000)}s`);
}
const planner = createPlanner(env);
for (const q of [
  'What did the August 2024 Stay Experience report say about cleanliness?',
  'Total Amazon spend in the Hilton PBI general ledger for July and August 2026',
  'Which labor summary files do we have for September 2026?',
]) {
  console.log('\nQ:', q);
  console.log(JSON.stringify(await runQuery({ db, gen, embedder, blob, planner }, q), null, 2));
}
await db.end();
