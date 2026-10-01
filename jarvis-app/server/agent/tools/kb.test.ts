import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let server: Server;
let kb: typeof import('./kb.ts');
let analytics: typeof import('./analytics.ts');
let parquet: Buffer;
const seen: { url: string; auth: string | undefined; body: string }[] = [];

beforeAll(async () => {
  process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-kb-'));
  analytics = await import('./analytics.ts');
  const pq = join(process.env.JARVIS_DATA_DIR, 'seed.parquet').replace(/\\/g, '/');
  await analytics.runSql(`COPY (SELECT 2026 AS year, 35.0 AS credit) TO '${pq}' (FORMAT parquet)`);
  parquet = readFileSync(pq);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url!, auth: req.headers.authorization, body });
      if (req.url === '/v1/query') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ answer_data: [{ year: 2026, value: 35 }], notes: [], confidence: 'high' })); }
      else if (req.url === '/v1/search') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ passages: [{ file: 'a.pdf', text: 'pool' }] })); }
      else if (req.url === '/v1/datasets/7/file') { res.end(parquet); }
      else if (req.url === '/v1/admin/generations' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ generations: [{ id: 1, status: 'active' }, { id: 2, status: 'ready', eval_hit5: 0.9 }] })); }
      else if (req.url === '/v1/admin/cutover') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ from: 1, to: 2 })); }
      else if (req.url === '/v1/corrections' && req.method === 'POST') { res.statusCode = 201; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ correction: { id: 7, text: 'The lobby renovation slipped to Q4 2026.', status: 'pending', scope: 'global' }, notes: [] })); }
      else if (req.url?.startsWith('/v1/corrections?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ corrections: [{ id: 7, status: 'pending' }] })); }
      else if (req.url === '/v1/corrections/7/decide') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ correction: { id: 7, status: 'approved' } })); }
      else { res.statusCode = 404; res.end(JSON.stringify({ error: 'No dataset with that id' })); }
    });
  }).listen(0);
  process.env.KB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KB_API_KEY = 'secret';
  process.env.KB_ADMIN_KEY = 'admin';
  kb = await import('./kb.ts');
});
afterAll(() => { server.close(); });

describe('kb tools', () => {
  it('kb_query posts the question with the API key and returns the JSON', async () => {
    const out = await kb.kbQuery('Amazon spend?');
    expect(JSON.parse(out)).toMatchObject({ answer_data: [{ year: 2026, value: 35 }], confidence: 'high' });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/query', auth: 'Bearer secret', body: JSON.stringify({ question: 'Amazon spend?' }) });
  });

  it('kb_search returns passages', async () => {
    expect(JSON.parse(await kb.kbSearch('pool', 5)).passages[0].file).toBe('a.pdf');
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ query: 'pool', k: 5 });
  });

  it('kb_fetch_dataset downloads Parquet and registers a DuckDB view', async () => {
    const out = await kb.kbFetchDataset([7]);
    expect(out).toContain('kb_dataset_7');
    expect(await analytics.runSql('SELECT credit FROM kb_dataset_7')).toContain('35');
  });

  it('reports kb-service errors plainly', async () => {
    await expect(kb.kbFetchDataset([404])).rejects.toThrow(/Knowledge base 404: No dataset with that id/);
  });

  it('admin calls use the admin key', async () => {
    const out = JSON.parse(await kb.kbGenerations());
    expect(out.generations[1]).toMatchObject({ id: 2, status: 'ready' });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/admin/generations', auth: 'Bearer admin' });
    expect(JSON.parse(await kb.kbCutover(2))).toEqual({ from: 1, to: 2 });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ generation: 2 });
  });

  it('cutover and rollback ask for approval first', async () => {
    const cut = kb.KB_TOOLS.find(t => t.def.name === 'kb_cutover')!;
    const roll = kb.KB_TOOLS.find(t => t.def.name === 'kb_rollback')!;
    const input = cut.parse({ generation: 2 });
    expect(await cut.gate!(input)).toMatchObject({ action: 'Switch the knowledge base to generation 2', risk: 'Irreversible' });
    expect(await roll.gate!(roll.parse({}))).toMatchObject({ action: 'Roll the knowledge base back to the previous generation', risk: 'Irreversible' });
    expect(cut.parse({ generation: 'two' })).toBe('"generation" must be a whole number');
  });

  it('records a correction, global by default, and decides with the right key', async () => {
    const c = JSON.parse(await kb.kbCorrect('actually the lobby reno slipped to Q4'));
    expect(c.correction).toMatchObject({ id: 7, status: 'pending', scope: 'global' });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ message: 'actually the lobby reno slipped to Q4', scope: 'global' });
    expect(seen.at(-1)!.auth).toBe('Bearer secret');
    expect(JSON.parse(await kb.kbCorrections('pending')).corrections[0].id).toBe(7);
    expect(seen.at(-1)!.url).toBe('/v1/corrections?status=pending');
    await kb.kbDecideCorrection(7, 'approve');
    expect(seen.at(-1)!.auth).toBe('Bearer admin');
    await kb.kbDecideCorrection(7, 'retire');
    expect(seen.at(-1)!.auth).toBe('Bearer secret');
  });

  it('validates correction tool inputs', () => {
    const t = kb.KB_TOOLS.find(x => x.def.name === 'kb_decide_correction')!;
    expect(t.parse({ id: 7, decision: 'maybe' })).toBe('"decision" must be approve, reject, keep or retire');
    const c = kb.KB_TOOLS.find(x => x.def.name === 'kb_correct')!;
    expect(c.parse({ message: 'x', scope: 'team' })).toBe('"scope" must be global or personal');
  });
});
