import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A throwaway data dir with a local provider selected, set before the modules read it.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-llm-'));
writeFileSync(join(dir, 'ai-provider.json'), JSON.stringify({ provider: 'compatible', models: { compatible: 'test-model' }, baseUrl: 'http://127.0.0.1:9/v1' }));
process.env.JARVIS_DATA_DIR = dir;
const { complete } = await import('./llm.ts');

const reply = (body: unknown, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe('complete() on an OpenAI-compatible provider', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('translates messages and tools, and maps tool calls back', async () => {
    const fetchMock = reply({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } }] } }] });
    vi.stubGlobal('fetch', fetchMock);
    const r = await complete({
      system: 'sys', maxTokens: 100, effort: 'low',
      tools: [{ name: 'fs_read', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't0', name: 'fs_list', input: { path: '.' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: [{ type: 'text', text: 'a.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test-model');
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'fs_read', description: 'read' } });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(body.messages[2]).toMatchObject({ content: 'ok', tool_calls: [{ id: 't0', function: { name: 'fs_list', arguments: '{"path":"."}' } }] });
    expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 't0' });
    expect(body.messages[4].content[0].image_url.url).toBe('data:image/png;base64,AAA');
    expect(r.stop_reason).toBe('tool_use');
    expect(r.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'fs_read', input: { path: 'a.txt' } }]);
  });

  it('returns plain text as end_turn', async () => {
    vi.stubGlobal('fetch', reply({ choices: [{ finish_reason: 'stop', message: { content: ' Hello ' } }] }));
    const r = await complete({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, effort: 'low' });
    expect(r).toEqual({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' });
  });

  it('reports HTTP errors as the SDK error classes', async () => {
    vi.stubGlobal('fetch', reply({ error: { message: 'bad key' } }, 401));
    await expect(complete({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, effort: 'low' }))
      .rejects.toBeInstanceOf(Anthropic.AuthenticationError);
  });
});
