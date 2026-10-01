import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Db } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { loadSources, upsertSources } from '../src/config.ts';
import { freshDb } from './helpers.ts';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.end(); });

describe('migrate', () => {
  it('creates kb_meta and generation 1, and is idempotent', async () => {
    expect(await migrate(db, 'fake-hash', 384)).toBe(1);
    const t = await db.query(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('kb_meta','kb_g1') ORDER BY 1`);
    expect(t.rows.map(r => r.t)).toEqual([
      'kb_g1.chunks', 'kb_g1.datasets', 'kb_g1.documents', 'kb_g1.folders', 'kb_g1.sections',
      'kb_meta.corrections', 'kb_meta.generations', 'kb_meta.query_log', 'kb_meta.settings', 'kb_meta.sources', 'kb_meta.sync_state',
    ]);
    const s = await db.query(`SELECT value FROM kb_meta.settings WHERE key = 'active_generation'`);
    expect(Number(s.rows[0].value)).toBe(1);
  });

  it('keeps the active generation when a different embedding model is configured', async () => {
    expect(await migrate(db, 'text-embedding-3-small', 1536)).toBe(1);
    const g = (await db.query('SELECT embedding_model, embedding_dim FROM kb_meta.generations WHERE id = 1')).rows[0];
    expect(g).toEqual({ embedding_model: 'fake-hash', embedding_dim: 384 });
  });

  it('loads sources.yaml and upserts sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-src-'));
    const file = join(dir, 'sources.yaml');
    writeFileSync(file, `sources:\n  - id: hilton-pbi\n    name: Hilton Palm Beach PBI\n    business: Cicero Hospitality Group\n    hotel: Hilton Palm Beach PBI\n    drive_id: "b!abc"\n    root_path: Hilton Palm Beach PBI\n    levels: [department, dataset]\n    enabled: true\n`);
    const sources = loadSources(file);
    expect(sources[0]).toMatchObject({ id: 'hilton-pbi', drive_id: 'b!abc', levels: ['department', 'dataset'], enabled: true });
    await upsertSources(db, sources);
    await upsertSources(db, sources);
    const r = await db.query('SELECT id, root_path FROM kb_meta.sources');
    expect(r.rows).toEqual([{ id: 'hilton-pbi', root_path: 'Hilton Palm Beach PBI' }]);
  });

  it('reads the model provider settings with cheap defaults', async () => {
    const { loadEnv } = await import('../src/config.ts');
    const keep = { ...process.env };
    try {
      delete process.env.KB_LLM_PROVIDER; delete process.env.KB_LLM_MODEL; delete process.env.KB_EMBED_PROVIDER;
      expect(loadEnv()).toMatchObject({ llm: { provider: 'anthropic', model: 'claude-haiku-4-5' }, embedProvider: 'local' });
      process.env.KB_LLM_PROVIDER = 'openai';
      expect(loadEnv().llm).toEqual({ provider: 'openai', model: 'gpt-5-mini' });
      process.env.KB_LLM_PROVIDER = 'azure'; process.env.KB_LLM_MODEL = 'tiro-mini'; process.env.AZURE_OPENAI_ENDPOINT = 'https://tiro.openai.azure.com/';
      expect(loadEnv()).toMatchObject({ llm: { provider: 'azure', model: 'tiro-mini' }, azure: { endpoint: 'https://tiro.openai.azure.com', apiVersion: '2024-10-21' } });
      process.env.KB_LLM_PROVIDER = 'mistral';
      expect(() => loadEnv()).toThrow(/KB_LLM_PROVIDER/);
    } finally { process.env = keep; }
  });

  it('rejects a source with an unknown level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-src-'));
    const file = join(dir, 'sources.yaml');
    writeFileSync(file, `sources:\n  - id: x\n    name: X\n    business: B\n    drive_id: d\n    root_path: X\n    levels: [floor]\n    enabled: true\n`);
    expect(() => loadSources(file)).toThrow(/levels/);
  });
});
