import Anthropic from '@anthropic-ai/sdk';
import { active, authHeaders, claude, http, httpError, type Active } from './claude.ts';

/**
 * One model turn on the provider picked in setup. Messages and tools stay in Anthropic's format
 * everywhere in Jarvis; for OpenAI, Gemini and local servers they are translated to the OpenAI
 * chat-completions API here, and the reply is translated back.
 */
export interface Turn {
  /** A string, or [stable, volatile]: the stable part is cached, the volatile part (time, task list, memory) is not. */
  system: string | string[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  effort: 'low' | 'high';
  signal?: AbortSignal;
  /** Called as a thought streams in (done=false, the text so far) and once it is complete (done=true). */
  onThought?: (text: string, done: boolean) => void;
  /** Called with the reply text so far as it streams in. */
  onText?: (text: string) => void;
}
export interface Reply { content: Anthropic.ContentBlockParam[]; stop_reason: string | null }

/** Haiku 4.5 takes neither adaptive thinking nor effort; newer models get both. */
const legacyModel = (model: string) => /haiku/i.test(model);

export function anthropicParams(model: string, t: Turn, system: Anthropic.TextBlockParam[]) {
  return {
    model, max_tokens: t.maxTokens,
    ...(legacyModel(model) ? {} : { output_config: { effort: t.effort }, thinking: { type: 'adaptive' as const, display: 'summarized' as const } }),
    cache_control: { type: 'ephemeral' as const }, system, tools: t.tools, messages: t.messages,
  };
}

export async function complete(t: Turn): Promise<Reply> {
  const a = active();
  if (a.provider !== 'anthropic') return openaiTurn(a, t);
  // "summarized" returns readable summaries of the reasoning and the notes written between tool calls.
  // Caching: tools + the stable system prompt are cached with an explicit breakpoint, and the top-level
  // marker caches the conversation so far, so each turn of a task re-reads its history instead of re-sending it.
  const parts = typeof t.system === 'string' ? [t.system] : t.system;
  const system: Anthropic.TextBlockParam[] = parts.filter(Boolean).map((text, i) => ({ type: 'text', text, ...(i === 0 ? { cache_control: { type: 'ephemeral' as const } } : {}) }));
  const stream = claude(a.key).messages.stream(anthropicParams(a.model, t, system), { signal: t.signal });
  if (t.onText) { const on = t.onText; stream.on('text', (_delta, snapshot) => on(snapshot)); }
  if (t.onThought) {
    const on = t.onThought;
    stream.on('thinking', (_delta, snapshot) => { if (snapshot.trim()) on(snapshot, false); });
    stream.on('contentBlock', b => { if (b.type === 'thinking' && b.thinking.trim()) on(b.thinking.trim(), true); });
  }
  const msg = await stream.finalMessage();
  // Text written in a turn that goes on to call a tool is a progress note ("Found X, now checking Y").
  if (t.onThought && msg.stop_reason === 'tool_use') {
    for (const b of msg.content) if (b.type === 'text' && b.text.trim()) t.onThought(b.text.trim(), true);
  }
  return { content: msg.content, stop_reason: msg.stop_reason };
}

type OpenAIMessage = Record<string, unknown>;

const imageUrl = (s: Anthropic.ImageBlockParam['source']) =>
  s.type === 'base64' ? `data:${s.media_type};base64,${s.data}` : s.type === 'url' ? s.url : '';

function toOpenAI(system: string, messages: Anthropic.MessageParam[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n');
      const calls = m.content.flatMap(b => (b.type === 'tool_use'
        ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : []));
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results become "tool" messages. Images (screenshots) can't go in those, so they follow in a user message.
    const parts: unknown[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const blocks = typeof b.content === 'string' ? [] : b.content ?? [];
        const text = typeof b.content === 'string' ? b.content : blocks.map(c => (c.type === 'text' ? c.text : c.type === 'image' ? '[image attached below]' : '')).join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text || (b.is_error ? 'Error' : 'OK') });
        for (const c of blocks) if (c.type === 'image' && imageUrl(c.source)) parts.push({ type: 'image_url', image_url: { url: imageUrl(c.source) } });
      } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && imageUrl(b.source)) parts.push({ type: 'image_url', image_url: { url: imageUrl(b.source) } });
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

interface OpenAIChoice {
  message?: { content?: string | null; refusal?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
  finish_reason?: string;
}

async function openaiTurn(a: Active, t: Turn): Promise<Reply> {
  const res = await http(a.baseUrl + '/chat/completions', {
    method: 'POST',
    signal: t.signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders(a.provider, a.key) },
    body: JSON.stringify({
      model: a.model,
      messages: toOpenAI(typeof t.system === 'string' ? t.system : t.system.filter(Boolean).join('\n\n'), t.messages),
      ...(t.tools.length ? { tools: t.tools.map(x => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.input_schema } })) } : {}),
    }),
  });
  if (!res.ok) throw await httpError(res);
  const data = (await res.json()) as { choices?: OpenAIChoice[] };
  const choice = data.choices?.[0];
  if (!choice?.message) throw Anthropic.APIError.generate(502, data, 'The model sent an empty reply.', res.headers);
  const content: Anthropic.ContentBlockParam[] = [];
  const text = choice.message.content?.trim();
  if (text) content.push({ type: 'text', text });
  // Other providers have no thinking blocks; text written alongside tool calls is their progress note.
  if (text && choice.message.tool_calls?.length) t.onThought?.(text, true);
  (choice.message.tool_calls ?? []).forEach((c, i) => {
    let input: unknown = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* bad JSON: the tool's own validation reports it */ }
    content.push({ type: 'tool_use', id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.function?.name ?? '', input });
  });
  const stop = content.some(b => b.type === 'tool_use') ? 'tool_use'
    : choice.message.refusal || choice.finish_reason === 'content_filter' ? 'refusal'
      : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stop_reason: stop };
}
