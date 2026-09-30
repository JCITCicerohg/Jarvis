import { DEFAULT_EMBED_DIM } from '../db/migrate.ts';

export interface Embedder { model: string; dim: number; embed(texts: string[]): Promise<number[][]> }

export type Extractor = (texts: string[], opts: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

const loadBgeSmall = async (): Promise<Extractor> => {
  const { pipeline } = await import('@huggingface/transformers');
  return (await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')) as unknown as Extractor;
};

/** Free, keyless embeddings: bge-small-en-v1.5 (384 dims) running in-process. Downloads once, then cached. */
export class LocalEmbedder implements Embedder {
  model = 'local:Xenova/bge-small-en-v1.5';
  dim = 384;
  private ext: Promise<Extractor> | null = null;
  constructor(private load: () => Promise<Extractor> = loadBgeSmall, private batch = 32) {}
  async embed(texts: string[]): Promise<number[][]> {
    const ext = await (this.ext ??= this.load());
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batch) out.push(...(await ext(texts.slice(i, i + this.batch), { pooling: 'cls', normalize: true })).tolist());
    return out;
  }
}
export interface EmbedTarget { url: string; headers: Record<string, string>; body: Record<string, unknown>; model: string }

const BATCH = 96;

export function openaiEmbedTarget(key: string): EmbedTarget {
  if (!key) throw new Error('OPENAI_API_KEY is not set; kb-service needs it for embeddings (or set KB_EMBED_PROVIDER=azure).');
  return { url: 'https://api.openai.com/v1/embeddings', headers: { Authorization: `Bearer ${key}` }, body: { model: 'text-embedding-3-small' }, model: 'text-embedding-3-small' };
}

/** An Azure OpenAI deployment of text-embedding-3-small (1536 dimensions). */
export function azureEmbedTarget(a: { endpoint: string; key: string; apiVersion: string; embedDeployment: string }): EmbedTarget {
  if (!a.endpoint || !a.key || !a.embedDeployment) throw new Error('Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_EMBED_DEPLOYMENT for Azure embeddings.');
  return {
    url: `${a.endpoint}/openai/deployments/${encodeURIComponent(a.embedDeployment)}/embeddings?api-version=${encodeURIComponent(a.apiVersion)}`,
    headers: { 'api-key': a.key }, body: {}, model: `azure:${a.embedDeployment}`,
  };
}

/** OpenAI-style embeddings endpoint (OpenAI or Azure OpenAI), batched with retry on 429/5xx. */
export class HttpEmbedder implements Embedder {
  model: string;
  dim = 1536;
  constructor(private target: EmbedTarget, private fetchImpl: typeof fetch = fetch, private backoffMs = 1000) { this.model = target.model; }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) out.push(...await this.batch(texts.slice(i, i + BATCH)));
    return out;
  }

  private async batch(input: string[], attempt = 0): Promise<number[][]> {
    const res = await this.fetchImpl(this.target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.target.headers },
      body: JSON.stringify({ ...this.target.body, input }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise(r => setTimeout(r, this.backoffMs * 2 ** attempt));
      return this.batch(input, attempt + 1);
    }
    if (!res.ok) throw new Error(`Embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Deterministic test embedder: hashed bag of words, unit length. */
export class FakeEmbedder implements Embedder {
  model = 'fake-hash';
  constructor(public dim = DEFAULT_EMBED_DIM) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const v = new Array<number>(this.dim).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[fnv1a(w) % this.dim] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map(x => x / n);
    });
  }
}
