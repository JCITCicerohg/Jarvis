import Anthropic from '@anthropic-ai/sdk';
import type { AgentAction, StartTaskInput } from '../src/types.ts';
import { complete } from './agent/llm.ts';
import { chatPrompt, type ChatTaskLine } from './agent/prompt.ts';
import { startRun } from './agent/runner.ts';
import { memoryContext, memoryQuery, memorySaveRule, memoryWrite, rulesText } from './agent/tools/memory.ts';
import { kbConfigured, kbQuery, kbCorrect } from './agent/tools/kb.ts';
import { store } from './state.ts';
import { engineSummary } from './integrations.ts';

const MAX_TURNS = 6;

export interface ChatBody {
  messages: { role: 'user' | 'assistant'; text: string }[];
  /** Demo mode only: the client's simulated tasks. Live mode reads the server store. */
  tasks?: ChatTaskLine[];
  live?: boolean;
  clock?: string;
}

const LIVE_START: Anthropic.Tool = {
  name: 'start_task',
  description: 'Start an autonomous background task. Jarvis runs it with its full toolset (memory, PowerShell, file system, admin escalation) and logs each step live.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short imperative title shown on the task card' },
      goal: { type: 'string', description: 'The complete goal with every detail the user gave, written so the task can run without asking' },
      app: { type: 'string', description: 'Main system, e.g. Windows, PowerShell, Git, Memory' },
      mode: { type: 'string', enum: ['CLI', 'API', 'Browser', 'Search', 'Browser + API'] },
    },
    required: ['title', 'goal'],
  },
};

const DEMO_START: Anthropic.Tool = {
  name: 'start_task',
  description: 'Start an autonomous background task that Jarvis runs and logs step by step.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short imperative title' },
      app: { type: 'string', description: 'Main system, e.g. Toast, BevSpot, M3, Outlook, Web' },
      mode: { type: 'string', enum: ['Browser', 'API', 'Search', 'Browser + API'] },
      steps: { type: 'array', items: { type: 'string' }, description: '4–6 concrete steps written as completed log lines, e.g. "Opened BevSpot › Inventory › Counts"' },
      risky_action: { type: 'string', description: 'Only if the task ends in sending, paying or deleting: a short label like "Send email to Dana"' },
    },
    required: ['title', 'app', 'mode', 'steps'],
  },
};

const DECIDE: Anthropic.Tool = {
  name: 'decide',
  description: 'Approve or decline a pending action on a waiting task.',
  input_schema: { type: 'object', properties: { task_id: { type: 'string' }, approve: { type: 'boolean' } }, required: ['task_id', 'approve'] },
};

const ASK: Anthropic.Tool = {
  name: 'ask_clarifying_question',
  description: 'Ask the user one clarifying question before acting, when the request is ambiguous or missing a detail you cannot infer from memory or the conversation. Give 2-4 short likely answers; they appear as tap-to-answer buttons. Your reply text should be the question itself.',
  input_schema: {
    type: 'object',
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    required: ['question'],
  },
};

const ANSWER: Anthropic.Tool = {
  name: 'answer_question',
  description: "Pass the user's answer to a task that is waiting on a question (see 'needs an answer' in the task list).",
  input_schema: { type: 'object', properties: { task_id: { type: 'string' }, answer: { type: 'string' } }, required: ['task_id', 'answer'] },
};

const MEMORY_QUERY: Anthropic.Tool = {
  name: 'memory_query',
  description: 'Search Jarvis memory (people, vendors, locations, systems, past work) and the user\'s saved rules.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const MEMORY_WRITE: Anthropic.Tool = {
  name: 'memory_write',
  description: 'Remember a durable fact the user told you about themselves, a person, place, vendor, system or project (e.g. "Dana Ruiz is my GM at Eastside", "I prefer morning meetings" is a rule instead). kind: semantic (how things are), episodic (what happened), procedural (how something is done).',
  input_schema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Who or what the fact is about, e.g. "Dana Ruiz" or "Me"' },
      entity_type: { type: 'string', enum: ['Organization', 'Location', 'System', 'Vendor', 'Person', 'Project'] },
      fact: { type: 'string' },
      kind: { type: 'string', enum: ['semantic', 'episodic', 'procedural'] },
    },
    required: ['entity', 'fact'],
  },
};

const MEMORY_RULE: Anthropic.Tool = {
  name: 'memory_save_rule',
  description: 'Save a rule or preference the user stated or corrected you on. It applies to all future tasks.',
  input_schema: { type: 'object', properties: { rule: { type: 'string' }, reason: { type: 'string' } }, required: ['rule'] },
};

const KB_QUERY: Anthropic.Tool = {
  name: 'kb_query',
  description: "Answer a question from the company's SharePoint documents and spreadsheets (hotel reports, GLs, labor, guest scores, trackers). Returns Result JSON; answer only from it and cite the file.",
  input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
};

const KB_CORRECT: Anthropic.Tool = {
  name: 'kb_correct',
  description: "Record the user's correction of a fact about company data (hotel reports, projects, figures). Company-wide by default, pending approval; scope 'personal' if they say it's just for them. If the result has 'clarify', ask that question.",
  input_schema: { type: 'object', properties: { message: { type: 'string' }, scope: { type: 'string', enum: ['global', 'personal'] } }, required: ['message'] },
};

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

async function runChatTool(b: Anthropic.ToolUseBlockParam, live: boolean, taskIds: Set<string>, actions: AgentAction[]): Promise<{ text: string; isError?: boolean }> {
  const i = (b.input ?? {}) as Record<string, unknown>;
  switch (b.name) {
    case 'start_task': {
      const title = text(i.title);
      if (!title) return { text: 'title is required', isError: true };
      const input: StartTaskInput = {
        title, app: text(i.app), mode: text(i.mode), goal: text(i.goal),
        steps: Array.isArray(i.steps) ? i.steps.filter((s): s is string => typeof s === 'string') : [],
        risky_action: text(i.risky_action),
      };
      const id = live ? startRun(input).id : 't' + Date.now().toString(36) + actions.length;
      actions.push({ type: 'start_task', id, input });
      taskIds.add(id);
      return { text: 'Started task ' + id };
    }
    case 'decide': {
      if (typeof i.task_id !== 'string' || typeof i.approve !== 'boolean') return { text: 'task_id and approve are required', isError: true };
      if (!taskIds.has(i.task_id)) return { text: 'Unknown task id ' + i.task_id, isError: true };
      if (live && !store.decide(i.task_id, i.approve)) return { text: 'That task has no pending approval.', isError: true };
      actions.push({ type: 'decide', task_id: i.task_id, approve: i.approve });
      return { text: 'Recorded' };
    }
    case 'ask_clarifying_question': {
      const question = text(i.question);
      if (!question) return { text: 'question is required', isError: true };
      const options = Array.isArray(i.options) ? i.options.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 4) : [];
      actions.push({ type: 'ask', question, options });
      return { text: 'Shown to the user. Now reply with the question and wait for their answer.' };
    }
    case 'answer_question': {
      const answer = text(i.answer);
      if (typeof i.task_id !== 'string' || !answer) return { text: 'task_id and answer are required', isError: true };
      if (!store.answer(i.task_id, answer)) return { text: 'That task is not waiting on a question.', isError: true };
      actions.push({ type: 'answer', task_id: i.task_id, answer });
      return { text: 'Passed on' };
    }
    case 'memory_query': {
      const q = text(i.query);
      return q ? { text: memoryQuery(q) } : { text: 'query is required', isError: true };
    }
    case 'memory_save_rule': {
      const rule = text(i.rule);
      if (!rule) return { text: 'rule is required', isError: true };
      const replaced = memorySaveRule(rule, text(i.reason));
      store.emitEvent({ type: 'memory' });
      actions.push({ type: 'memory', text: (replaced ? 'Updated a rule: ' : 'Learned: ') + rule });
      return { text: replaced ? 'Rule saved. It replaced the older rule: ' + replaced : 'Rule saved' };
    }
    case 'memory_write': {
      const entity = text(i.entity), fact = text(i.fact);
      if (!entity || !fact) return { text: 'entity and fact are required', isError: true };
      const kind = i.kind === 'episodic' || i.kind === 'procedural' ? i.kind : 'semantic';
      const r = memoryWrite({ entity, entity_type: text(i.entity_type), fact, kind, source: 'Told by the user' });
      store.emitEvent({ type: 'memory' });
      if (r.added) actions.push({ type: 'memory', text: `Remembered · ${entity}: ${fact}` });
      return { text: r.added ? 'Saved' : 'Already known' };
    }
    case 'kb_query': {
      const q = text(i.question);
      if (!q) return { text: 'question is required', isError: true };
      try { return { text: await kbQuery(q) }; } catch (e) { return { text: (e as Error).message, isError: true }; }
    }
    case 'kb_correct': {
      const message = text(i.message);
      if (!message) return { text: 'message is required', isError: true };
      const scope = i.scope === 'personal' ? 'personal' : 'global';
      try { const r = await kbCorrect(message, scope); actions.push({ type: 'memory', text: 'Saved a correction: ' + message }); return { text: r }; }
      catch (e) { return { text: (e as Error).message, isError: true }; }
    }
  }
  return { text: 'Unknown tool ' + b.name, isError: true };
}

/** Runs one chat turn (with its tool loop) and returns the spoken reply plus the actions taken. */
export async function chat(body: ChatBody): Promise<{ reply: string; actions: AgentAction[] }> {
  const live = !!body.live;
  const lines: ChatTaskLine[] = live
    ? store.tasks.map(t => ({
      id: t.id, title: t.title, status: t.status, paused: t.paused,
      approval: t.status === 'waiting' && t.approval ? t.approval.action : null,
      question: t.status === 'waiting' && t.question ? t.question.text : null,
      lastStep: t.steps[t.steps.length - 1]?.text,
    }))
    : body.tasks ?? [];
  const messages: Anthropic.MessageParam[] = body.messages.slice(-12).map(m => ({ role: m.role, content: m.text }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  // Look memory up front for the latest message (and the one before, for follow-ups), so most questions
  // are answered in one model call instead of a memory_query round trip.
  const recent = body.messages.filter(m => m.role === 'user').slice(-2).map(m => m.text).join(' ');
  const memory = live ? memoryContext(recent) : '';
  const system = chatPrompt(lines, live ? rulesText() : '(demo mode)', live, body.clock ?? new Date().toLocaleTimeString(), live ? await engineSummary() : '', memory);
  const tools = live ? [LIVE_START, DECIDE, ANSWER, ASK, MEMORY_QUERY, MEMORY_WRITE, MEMORY_RULE, ...(kbConfigured() ? [KB_QUERY, KB_CORRECT] : [])] : [DEMO_START, DECIDE, ASK];
  const taskIds = new Set(lines.map(t => t.id));
  const actions: AgentAction[] = [];

  let reply = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await complete({
      system, tools, messages, maxTokens: 8000, effort: 'low',
      onThought: (t, done) => store.thought('chat', t, done),
      onText: t => store.replyText(t),
    });
    if (response.stop_reason === 'refusal') return { reply: "I can't help with that one.", actions };
    messages.push({ role: 'assistant', content: response.content });
    const t = response.content.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map(b => b.text).join(' ').trim();
    if (t) reply = t;
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') break;
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(response.content
      .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
      .map(async b => {
        const r = await runChatTool(b, live, taskIds, actions);
        return { type: 'tool_result' as const, tool_use_id: b.id, content: r.text, ...(r.isError ? { is_error: true } : {}) };
      }));
    messages.push({ role: 'user', content: results });
  }
  return { reply: reply || 'Done.', actions };
}
