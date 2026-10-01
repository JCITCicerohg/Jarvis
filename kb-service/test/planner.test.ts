import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/query/catalog.ts';
import { AnthropicJson, ChatJson, azureJson, openaiJson, type CreateClient } from '../src/llm/json-model.ts';
import { ModelPlanner, PLANNER_JSON_SCHEMA, fallbackPlan, planQuestion, type Planner } from '../src/query/planner.ts';
import { createEmbedder, createJsonModel } from '../src/llm/factory.ts';
import { PlannerOutput } from '../src/query/plan.ts';
import type { Env } from '../src/config.ts';

process.env.ANTHROPIC_API_KEY ??= 'test';

const CATALOG: Catalog = { hotels: ['Hilton Palm Beach PBI'], departments: ['Accounting'], fileTypes: ['xlsx'], datasets: [] };
const PLAN = fallbackPlan('x');

describe('PLANNER_JSON_SCHEMA', () => {
  it('lists every PlannerOutput key as required, with no extra properties', () => {
    expect(PLANNER_JSON_SCHEMA.required).toEqual(Object.keys(PlannerOutput.shape));
    expect(PLANNER_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('AnthropicJson', () => {
  it('sends a JSON schema via output_config, no thinking, and parses the text block', async () => {
    let args: Record<string, unknown> = {};
    const client: CreateClient = { messages: { create: async a => { args = a; return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn' }; } } };
    const out = await new ModelPlanner(new AnthropicJson(client)).plan('Amazon spend?', CATALOG, '2026-10-01');
    expect(out).toEqual(PLAN);
    expect(args.model).toBe('claude-haiku-4-5');
    expect(args).not.toHaveProperty('thinking');
    expect(args.output_config).toEqual({ format: { type: 'json_schema', schema: PLANNER_JSON_SCHEMA } });
    expect(JSON.stringify(args.messages)).toContain('Today: 2026-10-01');
    expect(JSON.stringify(args.messages)).toContain('Hilton Palm Beach PBI');
  });

  it('throws on a refusal', async () => {
    const client: CreateClient = { messages: { create: async () => ({ content: [], stop_reason: 'refusal' }) } };
    await expect(new AnthropicJson(client).json('s', 'u', {})).rejects.toThrow(/refusal/);
  });
});

describe('ChatJson (OpenAI / Azure)', () => {
  const capture = () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fake = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ choices: [{ message: { content: JSON.stringify(PLAN) } }] });
    }) as unknown as typeof fetch;
    return { seen, fake };
  };

  it('OpenAI: strict json_schema response format with Bearer auth', async () => {
    const { seen, fake } = capture();
    const m = new ChatJson({ ...openaiJson('sk', 'gpt-5-mini').target }, fake);
    expect(await m.json('sys', 'user', PLANNER_JSON_SCHEMA)).toEqual(PLAN);
    expect(seen[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0].headers.Authorization).toBe('Bearer sk');
    expect(seen[0].body).toMatchObject({ model: 'gpt-5-mini', response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: PLANNER_JSON_SCHEMA } } });
    expect(seen[0].body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }]);
  });

  it('Azure: deployment URL, api-key header, no model field', async () => {
    const { seen, fake } = capture();
    const m = new ChatJson({ ...azureJson({ endpoint: 'https://tiro.openai.azure.com', key: 'az', apiVersion: '2024-10-21' }, 'tiro-mini').target }, fake);
    await m.json('s', 'u', {});
    expect(seen[0].url).toBe('https://tiro.openai.azure.com/openai/deployments/tiro-mini/chat/completions?api-version=2024-10-21');
    expect(seen[0].headers['api-key']).toBe('az');
    expect(seen[0].body).not.toHaveProperty('model');
  });

  it('reports refusals and HTTP errors', async () => {
    const refuse = (async () => Response.json({ choices: [{ message: { refusal: 'no' } }] })) as unknown as typeof fetch;
    await expect(new ChatJson(openaiJson('k', 'm').target, refuse).json('s', 'u', {})).rejects.toThrow(/refus/);
    const bad = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(new ChatJson(openaiJson('k', 'm').target, bad).json('s', 'u', {})).rejects.toThrow(/401/);
  });

  it('redacts OpenAI Bearer credentials from error messages', async () => {
    const fake = (async () => new Response('bad key sk-secret-9 for Bearer sk-secret-9', { status: 401 })) as unknown as typeof fetch;
    const target = openaiJson('sk-secret-9', 'm').target;
    await expect(new ChatJson(target, fake).json('s', 'u', {})).rejects.toThrow(/chat completions 401/);
    try {
      await new ChatJson(target, fake).json('s', 'u', {});
    } catch (e) {
      expect(String(e)).not.toContain('sk-secret-9');
      expect(String(e)).toContain('[redacted]');
    }
  });

  it('redacts Azure api-key credentials from error messages', async () => {
    const fake = (async () => new Response('bad key az-secret-9 for api-key az-secret-9', { status: 401 })) as unknown as typeof fetch;
    const target = azureJson({ endpoint: 'https://tiro.openai.azure.com', key: 'az-secret-9', apiVersion: '2024-10-21' }, 'tiro-mini').target;
    await expect(new ChatJson(target, fake).json('s', 'u', {})).rejects.toThrow(/chat completions 401/);
    try {
      await new ChatJson(target, fake).json('s', 'u', {});
    } catch (e) {
      expect(String(e)).not.toContain('az-secret-9');
      expect(String(e)).toContain('[redacted]');
    }
  });
});

describe('planQuestion', () => {
  it('retries once, then falls back to a plain search with a note', async () => {
    let calls = 0;
    const flaky: Planner = { plan: async () => { calls++; throw new Error('boom'); } };
    const r = await planQuestion(flaky, 'pool feedback', CATALOG, '2026-10-01');
    expect(calls).toBe(2);
    expect(r.raw).toEqual(fallbackPlan('pool feedback'));
    expect(r.notes).toEqual(['The question planner was unavailable, so this is a plain search with no filters.']);
  });

  it('rejects a model reply that does not match the schema', async () => {
    const model = { name: 'x', json: async () => ({ intent: 'weather' }) };
    await expect(new ModelPlanner(model).plan('q', CATALOG, '2026-10-01')).rejects.toThrow(/invalid plan/);
  });
});

describe('factory', () => {
  const env = (over: Partial<Env>): Env => ({
    databaseUrl: '', port: 0, blobDir: '', sourcesFile: '', apiKeys: new Map(), adminKeys: new Map(), openaiKey: 'sk', syncMinutes: 5, ms: null, configVersion: null, evalFile: 'eval/questions.jsonl',
    llm: { provider: 'anthropic', model: 'claude-haiku-4-5' }, embedProvider: 'openai',
    azure: { endpoint: 'https://tiro.openai.azure.com', key: 'az', apiVersion: '2024-10-21', embedDeployment: 'emb' }, ...over,
  });
  it('picks the provider from env', () => {
    expect(createJsonModel(env({})).name).toBe('anthropic:claude-haiku-4-5');
    expect(createJsonModel(env({ llm: { provider: 'openai', model: 'gpt-5-mini' } })).name).toBe('openai:gpt-5-mini');
    expect(createJsonModel(env({ llm: { provider: 'azure', model: 'tiro-mini' } })).name).toBe('azure:tiro-mini');
    expect(() => createJsonModel(env({ llm: { provider: 'azure', model: '' } }))).toThrow(/KB_LLM_MODEL/);
    expect(createEmbedder(env({})).model).toBe('text-embedding-3-small');
    expect(createEmbedder(env({ embedProvider: 'azure' })).model).toBe('azure:emb');
    expect(createEmbedder(env({ embedProvider: 'local' }))).toMatchObject({ model: 'local:Xenova/bge-small-en-v1.5', dim: 384 });
  });
});

describe.skipIf(!process.env.RUN_LIVE)('live planner (RUN_LIVE=1, uses the configured provider)', () => {
  it('plans a numeric comparison', async () => {
    const { loadEnv } = await import('../src/config.ts');
    const { createPlanner } = await import('../src/llm/factory.ts');
    const cat: Catalog = { ...CATALOG, datasets: [{ name: "GL's", department: 'Accounting', from: '2025-01-01', to: '2026-08-31', files: 20, columns: [{ name: 'post_date', type: 'date' }, { name: 'reference', type: 'text' }, { name: 'credit', type: 'number' }] }] };
    const p = await createPlanner(loadEnv()).plan('How much did we spend with Amazon at Hilton PBI Jan to Aug this year vs last year?', cat, '2026-10-01');
    expect(p.intent).toBe('numeric_compare');
    expect(p.measure?.dataset).toBe("GL's");
    expect(p.any_of_periods).toHaveLength(2);
  });
});
