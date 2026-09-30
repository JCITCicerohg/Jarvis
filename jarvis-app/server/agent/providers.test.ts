import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-prov-'));
const { PROVIDERS, azureBase, authHeaders } = await import('./claude.ts');
const { anthropicParams } = await import('./llm.ts');

const turn = { system: 's', tools: [], messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100, effort: 'low' as const };

describe('providers', () => {
  it('defaults to the cheapest model per provider', () => {
    expect(PROVIDERS.anthropic.model).toBe('claude-haiku-4-5');
    expect(PROVIDERS.openai.model).toBe('gpt-5-mini');
    expect(PROVIDERS.gemini.model).toBe('gemini-2.5-flash');
    expect(PROVIDERS.azure).toMatchObject({ name: 'Azure OpenAI', short: 'Azure', env: 'AZURE_OPENAI_API_KEY', needsKey: true });
  });

  it('normalizes Azure endpoints and uses the api-key header', () => {
    for (const e of ['https://tiro.openai.azure.com', 'https://tiro.openai.azure.com/', 'https://tiro.openai.azure.com/openai/v1', 'https://tiro.openai.azure.com/openai/deployments/x']) {
      expect(azureBase(e)).toBe('https://tiro.openai.azure.com/openai/v1');
    }
    expect(authHeaders('azure', 'az')).toEqual({ 'api-key': 'az' });
    expect(authHeaders('openai', 'sk')).toEqual({ Authorization: 'Bearer sk' });
    expect(authHeaders('compatible', '')).toEqual({});
  });

  it('sends no thinking or effort to Haiku, and keeps them for Opus/Sonnet', () => {
    const haiku = anthropicParams('claude-haiku-4-5', turn, []);
    expect(haiku).not.toHaveProperty('thinking');
    expect(haiku).not.toHaveProperty('output_config');
    const opus = anthropicParams('claude-opus-5-5', turn, []);
    expect(opus).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } });
  });
});
