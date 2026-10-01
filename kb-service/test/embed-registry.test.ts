import { describe, expect, it } from 'vitest';
import { embedderFor } from '../src/embed/registry.ts';

const env = { openaiKey: 'sk', azure: { endpoint: 'https://tiro.openai.azure.com', key: 'az', apiVersion: '2024-10-21', embedDeployment: 'ignored' } };

describe('embedderFor', () => {
  it('maps every stored model name to its embedder, cached', () => {
    expect(embedderFor('fake-hash', env)).toMatchObject({ model: 'fake-hash', dim: 384 });
    expect(embedderFor('local:Xenova/bge-small-en-v1.5', env)).toMatchObject({ model: 'local:Xenova/bge-small-en-v1.5', dim: 384 });
    expect(embedderFor('text-embedding-3-small', env)).toMatchObject({ model: 'text-embedding-3-small', dim: 1536 });
    expect(embedderFor('azure:emb-small', env)).toMatchObject({ model: 'azure:emb-small', dim: 1536 });
    expect(embedderFor('fake-hash', env)).toBe(embedderFor('fake-hash', env));
  });
  it('refuses unknown models', () => {
    expect(() => embedderFor('mystery-model', env)).toThrow(/No embedder for model "mystery-model"/);
  });
});
