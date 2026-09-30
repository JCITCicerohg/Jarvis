/** One structured-output call: returns the JSON object the model produced for `schema`. */
export interface JsonModel { name: string; json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> }

export interface CreateClient {
  messages: { create(args: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[]; stop_reason: string | null }> };
}

/** Anthropic Messages API with a JSON-schema output format. No thinking or effort (Haiku 4.5 takes neither). */
export class AnthropicJson implements JsonModel {
  name: string;
  constructor(private client: CreateClient, private model = 'claude-haiku-4-5') { this.name = `anthropic:${model}`; }
  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.messages.create({
      model: this.model, max_tokens: 2000, system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    if (res.stop_reason === 'refusal') throw new Error('model refusal');
    const text = res.content.find(b => b.type === 'text')?.text;
    if (!text) throw new Error(`no JSON in the reply (stop_reason ${res.stop_reason})`);
    return JSON.parse(text);
  }
}

export interface ChatTarget { url: string; headers: Record<string, string>; model?: string; name: string }

/** OpenAI-style chat completions (OpenAI or Azure OpenAI) with a strict JSON-schema response format. */
export class ChatJson implements JsonModel {
  name: string;
  constructor(private target: ChatTarget, private fetchImpl: typeof fetch = fetch) { this.name = target.name; }
  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(this.target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.target.headers },
      body: JSON.stringify({
        ...(this.target.model ? { model: this.target.model } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema } },
      }),
    });
    if (!res.ok) throw new Error(`chat completions ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
    const msg = data.choices?.[0]?.message;
    if (msg?.refusal) throw new Error('model refused: ' + msg.refusal);
    if (!msg?.content) throw new Error('no JSON in the reply');
    return JSON.parse(msg.content);
  }
}

export function openaiJson(key: string, model: string) {
  if (!key) throw new Error('OPENAI_API_KEY is not set for KB_LLM_PROVIDER=openai.');
  const target: ChatTarget = { url: 'https://api.openai.com/v1/chat/completions', headers: { Authorization: `Bearer ${key}` }, model, name: `openai:${model}` };
  return { target, model: new ChatJson(target) };
}

export function azureJson(a: { endpoint: string; key: string; apiVersion: string }, deployment: string) {
  if (!a.endpoint || !a.key) throw new Error('Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY for KB_LLM_PROVIDER=azure.');
  if (!deployment) throw new Error('Set KB_LLM_MODEL to the Azure OpenAI deployment name for KB_LLM_PROVIDER=azure.');
  const target: ChatTarget = {
    url: `${a.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(a.apiVersion)}`,
    headers: { 'api-key': a.key }, name: `azure:${deployment}`,
  };
  return { target, model: new ChatJson(target) };
}
