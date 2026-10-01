import type { Env } from '../config.ts';
import { FakeEmbedder, HttpEmbedder, LocalEmbedder, azureEmbedTarget, openaiEmbedTarget, type Embedder } from './embedder.ts';

const cache = new Map<string, Embedder>();

/** The embedder a generation was built with, from its stored model name. */
export function embedderFor(model: string, env: Pick<Env, 'openaiKey' | 'azure'>): Embedder {
  const hit = cache.get(model);
  if (hit) return hit;
  let e: Embedder;
  if (model === 'fake-hash') e = new FakeEmbedder();
  else if (model === 'local:Xenova/bge-small-en-v1.5') e = new LocalEmbedder();
  else if (model === 'text-embedding-3-small') e = new HttpEmbedder(openaiEmbedTarget(env.openaiKey));
  else if (model.startsWith('azure:')) e = new HttpEmbedder(azureEmbedTarget({ ...env.azure, embedDeployment: model.slice('azure:'.length) }));
  else throw new Error(`No embedder for model "${model}"`);
  cache.set(model, e);
  return e;
}
