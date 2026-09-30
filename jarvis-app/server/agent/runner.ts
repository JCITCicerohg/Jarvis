import Anthropic from '@anthropic-ai/sdk';
import { S, clock } from '../../src/data.ts';
import type { Task } from '../../src/types.ts';
import { store } from '../state.ts';
import { complete } from './llm.ts';
import { taskPrompt } from './prompt.ts';
import { TASK_TOOLS, callTool } from './tools/index.ts';
import { memoryQuery, rememberTask } from './tools/memory.ts';
import { engineSummary } from '../integrations.ts';

const MAX_TURNS = 40;
const controllers = new Map<string, AbortController>();
let failed: ((task: Task, e: unknown) => void) | null = null;
/** Called when a run ends in an error (not when the user stops it). */
export const onRunFailed = (fn: (task: Task, e: unknown) => void) => { failed = fn; };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});

function finish(id: string, summary: string, nextSteps: string[] = []) {
  store.update(id, t => ({
    ...t, status: 'done', approval: null, question: null, plan: [],
    report: t.report ?? { summary, nextSteps },
    steps: [...t.steps, S('done', 'Task complete', clock())],
  }));
  const t = store.get(id);
  if (!t) return;
  store.toast({ kind: 'done', task: id, title: 'Task complete', text: t.title });
  try {
    if (t.report) { rememberTask({ title: t.title, app: t.app, summary: t.report.summary, nextSteps: t.report.nextSteps }); store.emitEvent({ type: 'memory' }); }
  } catch (e) { console.error('Could not save the task to memory:', e); }
}

/** Observe → Reason → Act → Report loop for one task. Resolves when the task ends. */
async function run(task: Task, signal: AbortSignal) {
  const memory = memoryQuery(task.goal || task.title);
  store.step(task.id, S('memory', 'Checked memory before starting', clock()));
  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: `Goal: ${task.goal || task.title}\n\nRelevant memory (Memory First):\n${memory}`,
  }];
  // The system prompt is frozen for the whole run: thinking blocks are bound to it, and
  // any edit makes the API reject them. Later state changes go in as appended system messages.
  let admin = store.admin, engines = await engineSummary();
  const system = taskPrompt(admin, engines);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    while (store.get(task.id)?.paused) await sleep(1000, signal);
    const nowEngines = await engineSummary();
    // A mid-conversation system message has to follow a user turn (here, the tool results).
    if ((store.admin !== admin || nowEngines !== engines) && messages[messages.length - 1].role === 'user') {
      const notes = [];
      if (store.admin !== admin) notes.push(store.admin ? 'Admin rights are now GRANTED for this session: use shell_exec elevated=true without asking.' : 'Admin rights were revoked: do not use elevated=true.');
      if (nowEngines !== engines) notes.push('Engine status changed: ' + nowEngines);
      messages.push({ role: 'system', content: `Update (${new Date().toLocaleTimeString()}): ${notes.join(' ')}` });
      admin = store.admin;
      engines = nowEngines;
    }

    const msg = await complete({
      system, tools: TASK_TOOLS, messages, maxTokens: 32000, effort: 'high', signal,
      onThought: (text, done) => store.thought(task.id, text, done),
    });

    if (msg.stop_reason === 'refusal') {
      finish(task.id, 'Jarvis declined this task for safety reasons.');
      return;
    }
    // Pass content back unchanged (incl. thinking blocks) so the conversation stays valid.
    messages.push({ role: 'assistant', content: msg.content });
    if (msg.stop_reason === 'pause_turn') continue;

    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !uses.length) {
      // Ended without calling report: use its text as the summary.
      const text = msg.content.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map(b => b.text).join('\n').trim();
      finish(task.id, text || (msg.stop_reason === 'max_tokens' ? 'Stopped: the response hit the length limit.' : 'Finished.'));
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let final = false;
    // Sequential on purpose: an approval pauses everything after it.
    for (const b of uses) {
      const out = await callTool(b, { taskId: task.id, signal }, a => store.askApproval(task.id, a, signal));
      const content: Anthropic.ToolResultBlockParam['content'] = out.image
        ? [{ type: 'image', source: { type: 'base64', media_type: out.image.mediaType, data: out.image.data } }, { type: 'text', text: out.text }]
        : out.text;
      results.push({ type: 'tool_result', tool_use_id: b.id, content, ...(out.isError ? { is_error: true } : {}) });
      if (out.final) final = true;
    }
    messages.push({ role: 'user', content: results });
    if (final) { finish(task.id, 'Finished.'); return; }
  }
  finish(task.id, `Stopped after ${MAX_TURNS} steps without finishing.`, ['Narrow the goal or split it into smaller tasks.']);
}

export function startRun(input: { title: string; goal?: string; app?: string; mode?: string }): Task {
  const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const app = input.app || 'Jarvis';
  const task: Task = {
    id, title: input.title, goal: input.goal || input.title, app, mode: input.mode || 'CLI',
    url: app + ' › ' + input.title, status: 'running', steps: [S('think', 'Planning from your request', clock())], plan: [],
  };
  store.add(task);
  store.toast({ kind: 'start', task: id, title: 'Started a task', text: task.title });
  const ac = new AbortController();
  controllers.set(id, ac);
  run(task, ac.signal)
    .catch(e => {
      if (ac.signal.aborted) {
        finish(id, 'Stopped by you.');
        return;
      }
      const msg = e instanceof Anthropic.APIError ? `Model error ${e.status}: ${e.message}` : (e as Error).message;
      console.error('Task', id, 'failed:', msg);
      store.step(id, S('error', msg.slice(0, 160), clock()));
      finish(id, 'The task stopped because of an error: ' + msg, ['Jarvis starts a self-repair task for errors in its own code. Retry once it reports.']);
      failed?.(task, e);
    })
    .finally(() => controllers.delete(id));
  return task;
}

export function stopRun(id: string) { controllers.get(id)?.abort(); }
export function stopAll() { for (const c of controllers.values()) c.abort(); return controllers.size; }
