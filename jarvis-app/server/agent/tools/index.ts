import type Anthropic from '@anthropic-ai/sdk';
import { S, clock } from '../../../src/data.ts';
import type { Approval, Risk } from '../../../src/types.ts';
import { audit } from '../../paths.ts';
import { store } from '../../state.ts';
import { memoryQuery, memorySaveRule, memoryWrite, type FactKind } from './memory.ts';
import {
  DEFAULT_CWD, adminAvailable, execElevated, execShell, fsExists, fsList, fsRead, fsWrite, resolvePath, startAdminWorker, type ExecResult,
} from './os.ts';
import { irreversibleReason } from './risk.ts';
import { ANALYTICS_TOOLS } from './analytics.ts';
import { BROWSER_TOOLS } from './browser.ts';
import { GRAPH_TOOLS } from './graph.ts';
import { KB_TOOLS } from './kb.ts';
import { SELFMOD_TOOLS } from './selfmod.ts';
import { engineBlocked, engineOf } from '../../integrations.ts';
import { bool, num, parser, short, str, strs, tool, type ToolCtx, type ToolOutput, type ToolSpec } from './spec.ts';

export type { ToolCtx, ToolOutput };

function execText(r: ExecResult) {
  const parts = [`exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`];
  if (r.stdout.trim()) parts.push('stdout:\n' + r.stdout.trimEnd());
  if (r.stderr.trim()) parts.push('stderr:\n' + r.stderr.trimEnd());
  return parts.join('\n');
}


const CORE_TOOLS: ToolSpec<unknown>[] = [
  tool<{ query: string }>({
    def: {
      name: 'memory_query',
      description: 'Hybrid_Memory_Engine: search semantic, episodic and procedural memory and the user\'s saved rules. Call this before starting any new sub-goal.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords to search for' } }, required: ['query'] },
    },
    parse: parser(o => ({ query: str(o, 'query')! })),
    step: i => ({ kind: 'memory', text: 'Checked memory for ' + short(i.query, 80) }),
    run: i => memoryQuery(i.query),
  }),
  tool<{ entity: string; entity_type?: string; fact: string; kind?: FactKind; links: string[] }>({
    def: {
      name: 'memory_write',
      description: 'Hybrid_Memory_Engine: store a durable fact about a person, vendor, location, system or project. kind: semantic (how things are), episodic (what happened), procedural (how to do a workflow).',
      input_schema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'The node the fact belongs to, e.g. "BevSpot" or "Dana Ruiz"' },
          entity_type: { type: 'string', enum: ['Organization', 'Location', 'System', 'Vendor', 'Person', 'Project'] },
          fact: { type: 'string' },
          kind: { type: 'string', enum: ['semantic', 'episodic', 'procedural'] },
          links: { type: 'array', items: { type: 'string' }, description: 'Labels of existing nodes this entity relates to' },
        },
        required: ['entity', 'fact'],
      },
    },
    parse: parser(o => {
      const kind = str(o, 'kind', false);
      return {
        entity: str(o, 'entity')!, entity_type: str(o, 'entity_type', false), fact: str(o, 'fact')!, links: strs(o, 'links'),
        kind: kind === 'episodic' || kind === 'procedural' ? kind : 'semantic',
      };
    }),
    step: i => ({ kind: 'memory', text: `Saved to memory · ${i.entity}: ${short(i.fact, 90)}` }),
    run: i => {
      const r = memoryWrite({ ...i, source: 'Learned during a task' });
      store.emitEvent({ type: 'memory' });
      return r.added ? 'Saved' : 'Already known (not duplicated)';
    },
  }),
  tool<{ rule: string; reason?: string }>({
    def: {
      name: 'memory_save_rule',
      description: 'Continuous learning: save a rule or preference the user stated or corrected you on. Saved rules are shown to you at the start of every task.',
      input_schema: { type: 'object', properties: { rule: { type: 'string' }, reason: { type: 'string' } }, required: ['rule'] },
    },
    parse: parser(o => ({ rule: str(o, 'rule')!, reason: str(o, 'reason', false) })),
    step: i => ({ kind: 'memory', text: 'Learned a new rule: ' + short(i.rule, 100) }),
    run: i => {
      const replaced = memorySaveRule(i.rule, i.reason);
      store.emitEvent({ type: 'memory' });
      return replaced ? 'Rule saved. It replaced the older rule: ' + replaced : 'Rule saved';
    },
  }),
  tool<{ command: string; cwd: string; timeoutMs: number; elevated: boolean }>({
    def: {
      name: 'shell_exec',
      description: 'OS_Controller_&_CLI: run a Windows PowerShell 5.1 command on the user\'s PC and get stdout, stderr and the exit code. Set elevated=true to run as Administrator (only after request_admin was approved). Commands with irreversible data loss are paused for the user\'s approval automatically.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: `Working directory; defaults to ${DEFAULT_CWD}` },
          timeout_sec: { type: 'number', description: 'Default 120, max 600' },
          elevated: { type: 'boolean' },
        },
        required: ['command'],
      },
    },
    parse: parser(o => {
      const elevated = bool(o, 'elevated');
      if (elevated && !adminAvailable()) throw new Error('admin access has not been granted this session. Call request_admin first.');
      return {
        command: str(o, 'command')!,
        cwd: resolvePath(str(o, 'cwd', false) ?? DEFAULT_CWD),
        timeoutMs: Math.min(Math.max(num(o, 'timeout_sec') ?? 120, 1), 600) * 1000,
        elevated,
      };
    }),
    step: i => ({ kind: 'shell', text: (i.elevated ? 'Ran as admin: ' : 'Ran: ') + short(i.command) }),
    gate: i => {
      const reason = irreversibleReason(i.command);
      return reason ? { action: reason, detail: 'This cannot be undone · ' + i.cwd, risk: 'Irreversible', preview: i.command } : null;
    },
    run: async (i, ctx) => {
      const r = i.elevated ? await execElevated(i.command, i.cwd, i.timeoutMs) : await execShell(i.command, i.cwd, i.timeoutMs, ctx.signal);
      audit({ task: ctx.taskId, tool: 'shell_exec', command: i.command, cwd: i.cwd, elevated: i.elevated, exitCode: r.exitCode, timedOut: r.timedOut, stderr: r.stderr.slice(0, 500) });
      if (r.exitCode !== 0) store.step(ctx.taskId, S('error', `Command exited with code ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`, clock()));
      return { text: execText(r), isError: r.exitCode !== 0 };
    },
  }),
  tool<{ path: string }>({
    def: {
      name: 'fs_list',
      description: 'OS_Controller_&_CLI: list a directory with sizes and modified times.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    parse: parser(o => ({ path: str(o, 'path')! })),
    step: i => ({ kind: 'file', text: 'Listed ' + short(resolvePath(i.path), 100) }),
    run: i => fsList(i.path),
  }),
  tool<{ path: string; maxBytes?: number }>({
    def: {
      name: 'fs_read',
      description: 'OS_Controller_&_CLI: read a text file (UTF-8).',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, max_bytes: { type: 'number', description: 'Default 100000' } }, required: ['path'] },
    },
    parse: parser(o => ({ path: str(o, 'path')!, maxBytes: num(o, 'max_bytes') })),
    step: i => ({ kind: 'file', text: 'Read ' + short(resolvePath(i.path), 100) }),
    run: i => fsRead(i.path, i.maxBytes),
  }),
  tool<{ path: string; content: string; append: boolean }>({
    def: {
      name: 'fs_write',
      description: 'OS_Controller_&_CLI: write or append a text file, creating parent folders. Overwriting an existing file asks the user first.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] },
    },
    parse: parser(o => {
      if (typeof o.content !== 'string') throw new Error('"content" must be a string');
      return { path: str(o, 'path')!, content: o.content, append: bool(o, 'append') };
    }),
    step: i => ({ kind: 'file', text: (i.append ? 'Appended to ' : 'Wrote ') + short(resolvePath(i.path), 100) }),
    gate: async i => (!i.append && await fsExists(i.path)
      ? { action: 'Overwrite ' + short(resolvePath(i.path), 80), detail: 'The current contents will be replaced', risk: 'Irreversible', preview: short(i.content, 1200) }
      : null),
    run: async (i, ctx) => {
      const out = await fsWrite(i.path, i.content, i.append);
      audit({ task: ctx.taskId, tool: 'fs_write', path: resolvePath(i.path), append: i.append, bytes: Buffer.byteLength(i.content) });
      return out;
    },
  }),
  tool<{ reason: string }>({
    def: {
      name: 'request_admin',
      description: 'Admin Escalation Protocol: ask the user once for Administrator rights for the rest of this session. After approval, a UAC prompt appears once; then use shell_exec with elevated=true without asking again.',
      input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'Why elevation is needed' } }, required: ['reason'] },
    },
    parse: parser(o => ({ reason: str(o, 'reason')! })),
    step: () => null,
    gate: i => (adminAvailable() ? null : {
      action: 'Grant admin rights for this session', risk: 'Admin',
      detail: 'Jarvis will run elevated commands without asking again until the server restarts. Irreversible actions still ask.',
      preview: i.reason,
    }),
    run: async () => {
      if (adminAvailable()) return 'Admin access is already active for this session.';
      try {
        await startAdminWorker();
        store.setAdmin(true);
        return 'Admin access granted for this session. Use shell_exec with elevated=true.';
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    },
  }),
  tool<{ action: string; detail: string; risk: Risk }>({
    def: {
      name: 'request_approval',
      description: 'Strategic interruption: pause for the user\'s approval before any action with irreversible financial or data-loss consequences that is not already gated (e.g. sending external email, paying, deleting records in a web app).',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Short label, e.g. "Pay $4,386.20"' },
          detail: { type: 'string' },
          risk: { type: 'string', enum: ['Send', 'Pay', 'Delete', 'Irreversible'] },
        },
        required: ['action', 'detail', 'risk'],
      },
    },
    parse: parser(o => {
      const risk = str(o, 'risk')! as Risk;
      if (!['Send', 'Pay', 'Delete', 'Irreversible'].includes(risk)) throw new Error('risk must be Send, Pay, Delete or Irreversible');
      return { action: str(o, 'action')!, detail: str(o, 'detail')!, risk };
    }),
    step: () => null,
    gate: i => ({ action: i.action, detail: i.detail, risk: i.risk }),
    run: () => 'Approved. Go ahead.',
  }),
  tool<{ question: string; options: string[]; why?: string }>({
    def: {
      name: 'ask_user',
      description: 'Ask the user a clarifying question and wait for the answer. Use it when the goal is unclear or missing a detail you cannot find in memory, files or context and a wrong guess would waste real work (which account, which date range, which of two plausible targets). Offer 2-4 short likely answers as options; the user can also type their own. Ask one question at a time, and not for things you can reasonably decide yourself.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One short, specific question' },
          options: { type: 'array', items: { type: 'string' }, description: '2-4 short likely answers' },
          why: { type: 'string', description: 'One line on why you need to know' },
        },
        required: ['question'],
      },
    },
    parse: parser(o => ({ question: str(o, 'question')!, options: strs(o, 'options').map(x => x.trim()).filter(Boolean).slice(0, 4), why: str(o, 'why', false) })),
    step: () => null,
    run: async (i, ctx) => {
      const answer = await store.askQuestion(ctx.taskId, { text: i.question, options: i.options, why: i.why }, ctx.signal);
      return 'The user answered: ' + answer;
    },
  }),
  tool<{ remaining: string[] }>({
    def: {
      name: 'update_plan',
      description: 'Show the user your remaining plan as a short list of upcoming steps. Call after planning and whenever the plan changes.',
      input_schema: { type: 'object', properties: { remaining: { type: 'array', items: { type: 'string' } } }, required: ['remaining'] },
    },
    parse: parser(o => ({ remaining: strs(o, 'remaining').slice(0, 12) })),
    step: () => null,
    run: (i, ctx) => {
      store.update(ctx.taskId, t => ({ ...t, plan: i.remaining.map(text => ({ kind: 'think' as const, text })) }));
      return 'Plan updated';
    },
  }),
  tool<{ broke: string; changed: string }>({
    def: {
      name: 'note_fix',
      description: 'Self-healing: record that something failed and how you worked around it, so the user sees "Jarvis fixed itself".',
      input_schema: { type: 'object', properties: { what_broke: { type: 'string' }, what_changed: { type: 'string' } }, required: ['what_broke', 'what_changed'] },
    },
    parse: parser(o => ({ broke: str(o, 'what_broke')!, changed: str(o, 'what_changed')! })),
    step: i => ({ kind: 'fix', text: `${i.broke} ${i.changed}` }),
    run: (i, ctx) => {
      store.update(ctx.taskId, t => ({ ...t, fix: { text: `${i.broke} ${i.changed}`, time: clock() } }));
      store.toast({ kind: 'fix', task: ctx.taskId, title: 'Jarvis fixed itself', text: i.changed });
      return 'Noted';
    },
  }),
  tool<{ summary: string; nextSteps: string[] }>({
    def: {
      name: 'report',
      description: 'Finish the task with a concise, structured report: what you retrieved, executed or modified, and the recommended next steps. This ends the task.',
      input_schema: {
        type: 'object',
        properties: { summary: { type: 'string' }, next_steps: { type: 'array', items: { type: 'string' } } },
        required: ['summary'],
      },
    },
    parse: parser(o => ({ summary: str(o, 'summary')!, nextSteps: strs(o, 'next_steps') })),
    step: () => null,
    run: (i, ctx) => {
      store.update(ctx.taskId, t => ({ ...t, report: i }));
      return { text: 'Reported', final: true };
    },
  }),
];

const TOOLS = [...CORE_TOOLS, ...BROWSER_TOOLS, ...GRAPH_TOOLS, ...ANALYTICS_TOOLS, ...KB_TOOLS, ...SELFMOD_TOOLS];
export const TASK_TOOLS: Anthropic.Tool[] = TOOLS.map(t => t.def);
const BY_NAME = new Map(TOOLS.map(t => [t.def.name, t]));

/**
 * Validates, gates (approval), logs a step for, and runs one tool call.
 * `ask` shows an approval and resolves with the user's decision.
 */
export async function callTool(
  block: Pick<Anthropic.ToolUseBlockParam, 'name' | 'input'>, ctx: ToolCtx, ask: (a: Approval) => Promise<boolean>,
): Promise<ToolOutput> {
  const spec = BY_NAME.get(block.name);
  if (!spec) return { text: `Unknown tool ${block.name}`, isError: true };
  const input = spec.parse((block.input ?? {}) as Record<string, unknown>);
  if (typeof input === 'string') return { text: 'Invalid input: ' + input, isError: true };
  const engine = engineOf(block.name);
  const blocked = engine && await engineBlocked(engine);
  if (blocked) return { text: blocked, isError: true };
  let approval;
  try {
    approval = spec.gate ? await spec.gate(input) : null;
  } catch (e) {
    return { text: 'Error: ' + ((e as Error).message || String(e)), isError: true };
  }
  if (approval && !(await ask(approval))) return { text: 'The user declined this action. Do not retry it; continue without it or report.' };
  const step = spec.step(input);
  if (step) store.step(ctx.taskId, S(step.kind, step.text, clock()));
  try {
    const out = await spec.run(input, ctx);
    return typeof out === 'string' ? { text: out } : out;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    store.step(ctx.taskId, S('error', short(msg, 140), clock()));
    return { text: 'Error: ' + msg, isError: true };
  }
}
