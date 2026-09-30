import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeEmbedder, HttpEmbedder, LocalEmbedder, azureEmbedTarget, openaiEmbedTarget } from '../src/embed/embedder.ts';
import { LocalBlobStore, safeKey } from '../src/store/blob.ts';

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('FakeEmbedder', () => {
  it('is deterministic, unit-length, and similar for overlapping words', async () => {
    const e = new FakeEmbedder();
    const [a, b, c] = await e.embed(['amazon purchases ledger', 'amazon ledger entries', 'guest cleanliness score']);
    expect(a).toHaveLength(384);
    expect(new FakeEmbedder(8).dim).toBe(8);
    expect(cos(a, a)).toBeCloseTo(1, 5);
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
    expect((await e.embed(['amazon purchases ledger']))[0]).toEqual(a);
  });
});

describe('LocalEmbedder', () => {
  it('loads the model once, batches, and asks for CLS pooling with normalized vectors', async () => {
    let loads = 0;
    const calls: { n: number; opts: unknown }[] = [];
    const ext = async (texts: string[], opts: unknown) => { calls.push({ n: texts.length, opts }); return { tolist: () => texts.map(t => [t.length]) }; };
    const e = new LocalEmbedder(async () => { loads++; return ext; }, 32);
    expect([e.model, e.dim]).toEqual(['local:Xenova/bge-small-en-v1.5', 384]);
    const out = await e.embed(Array.from({ length: 40 }, (_, i) => 'x'.repeat(i + 1)));
    await e.embed(['again']);
    expect(loads).toBe(1);
    expect(calls.map(c => c.n)).toEqual([32, 8, 1]);
    expect(calls[0].opts).toEqual({ pooling: 'cls', normalize: true });
    expect(out[39]).toEqual([40]);
  });
});

describe.skipIf(!process.env.RUN_LIVE)('LocalEmbedder with the real model (RUN_LIVE=1, downloads ~130 MB once)', () => {
  it('returns 384-dim unit vectors that rank related text higher', async () => {
    const [a, b, c] = await new LocalEmbedder().embed(['guest room cleanliness score', 'housekeeping cleanliness rating', 'general ledger amazon purchase']);
    expect(a).toHaveLength(384);
    expect(cos(a, a)).toBeCloseTo(1, 3);
    expect(cos(a, b)).toBeGreaterThan(cos(a, c));
  }, 300_000);
});

describe('HttpEmbedder', () => {
  it('batches requests, keeps order and retries on 429 (OpenAI)', async () => {
    const calls: { url: string; auth: string; model: unknown; n: number }[] = [];
    let first = true;
    const fake = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body);
      if (first) { first = false; return new Response('slow down', { status: 429 }); }
      calls.push({ url, auth: init.headers.Authorization, model: body.model, n: body.input.length });
      return Response.json({ data: (body.input as string[]).map((t, i) => ({ index: i, embedding: [t.length] })) });
    }) as unknown as typeof fetch;
    const e = new HttpEmbedder(openaiEmbedTarget('k'), fake, 0);
    expect(e.model).toBe('text-embedding-3-small');
    const texts = Array.from({ length: 150 }, (_, i) => 'x'.repeat(i + 1));
    const out = await e.embed(texts);
    expect(calls.map(c => c.n)).toEqual([96, 54]);
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/embeddings', auth: 'Bearer k', model: 'text-embedding-3-small' });
    expect(out.map(v => v[0])).toEqual(texts.map(t => t.length));
  });

  it('calls an Azure OpenAI deployment with the api-key header', async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const fake = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return Response.json({ data: [{ index: 0, embedding: [1] }] });
    }) as unknown as typeof fetch;
    const e = new HttpEmbedder(azureEmbedTarget({ endpoint: 'https://tiro.openai.azure.com', key: 'az', apiVersion: '2024-10-21', embedDeployment: 'emb-small' }), fake, 0);
    await e.embed(['hi']);
    expect(e.model).toBe('azure:emb-small');
    expect(seen!.url).toBe('https://tiro.openai.azure.com/openai/deployments/emb-small/embeddings?api-version=2024-10-21');
    expect(seen!.headers['api-key']).toBe('az');
    expect(seen!.body).toEqual({ input: ['hi'] });
  });

  it('refuses to start without a key or deployment', () => {
    expect(() => openaiEmbedTarget('')).toThrow(/OPENAI_API_KEY/);
    expect(() => azureEmbedTarget({ endpoint: '', key: 'k', apiVersion: 'v', embedDeployment: 'd' })).toThrow(/AZURE_OPENAI_ENDPOINT/);
  });
});

describe('LocalBlobStore', () => {
  it('puts, gets, resolves local paths and removes', async () => {
    const s = new LocalBlobStore(mkdtempSync(join(tmpdir(), 'kb-blob-')));
    const key = safeKey('tidy', 'hilton-pbi', "GL's", 'Aug 2026.parquet');
    expect(key).toBe('tidy/hilton-pbi/gls/aug-2026.parquet');
    await s.put(key, Buffer.from('hi'));
    expect((await s.get(key)).toString()).toBe('hi');
    expect(await s.localPath(key)).toMatch(/aug-2026\.parquet$/);
    await s.remove(key);
    await expect(s.get(key)).rejects.toThrow();
  });
});
