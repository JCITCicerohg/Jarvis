import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'jarvis-azure-'));
writeFileSync(join(dir, 'ai-provider.json'), JSON.stringify({ provider: 'azure', models: { azure: 'tiro-mini' }, baseUrls: { azure: 'https://tiro.openai.azure.com' } }));
process.env.JARVIS_DATA_DIR = dir;
process.env.AZURE_OPENAI_API_KEY = 'az';
const { complete } = await import('./llm.ts');

describe('complete() on Azure OpenAI', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('calls the v1 chat completions endpoint with the deployment as model and the api-key header', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Hi' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const r = await complete({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, effort: 'low' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://tiro.openai.azure.com/openai/v1/chat/completions');
    expect((init!.headers as Record<string, string>)['api-key']).toBe('az');
    expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init!.body)).model).toBe('tiro-mini');
    expect(r).toEqual({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' });
  });
});
