import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { engineOn } from '../integrations.ts';
import { NotConfiguredError, keyStatus } from './claude.ts';
import { onRunFailed, startRun } from './runner.ts';
import { INCIDENT_FILE, PATCH_DIR, type Incident } from './tools/patches.ts';

/*
 * Self-repair: when Jarvis's own code fails (a task or chat errors, the UI throws, the server
 * crashes, or a patch had to be rolled back), start a background task that diagnoses it and
 * proposes a fix. The fix still goes through self_propose_patch, so the user approves the diff.
 * Rate-limited and persisted, so a crash loop can't spawn endless repairs.
 */

export type Source = 'task' | 'chat' | 'client' | 'crash' | 'rollback';

const STATE = join(PATCH_DIR, 'autofix.json');
const LOG = join(DATA_DIR, 'server.log');
const SAME_ERROR_MS = 30 * 60_000;
const MAX_PER_HOUR = 4;

interface State { seen: Record<string, number>; started: number[]; repairTasks: string[] }
let state: State = { seen: {}, started: [], repairTasks: [] };
try { if (existsSync(STATE)) state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { /* defaults */ }
const save = () => { try { writeFileSync(STATE, JSON.stringify(state)); } catch (e) { console.error('autofix state write failed', e); } };

/** Errors that are about the outside world (network, limits, account), not Jarvis's code. */
export function isOwnBug(e: unknown) {
  return !(e instanceof NotConfiguredError
    || e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError
    || e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.AuthenticationError
    || e instanceof Anthropic.PermissionDeniedError
    || (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 413)));
}

const signature = (source: Source, error: string) =>
  source + ':' + error.replace(/req_[A-Za-z0-9]+/g, '').replace(/\b[0-9a-f]{6,}\b/gi, '').replace(/\d+/g, '#').slice(0, 160);

/** Starts a repair task for an error, unless it was just handled or the hourly cap is hit. */
export function reportIncident(i: { source: Source; error: string; context?: string; taskId?: string }) {
  if (process.env.JARVIS_TEST_INSTANCE || !keyStatus().configured || !engineOn('selfmod')) return null;
  if (i.taskId && state.repairTasks.includes(i.taskId)) return null; // a repair that failed doesn't repair itself
  const now = Date.now();
  const sig = signature(i.source, i.error);
  if (now - (state.seen[sig] ?? 0) < SAME_ERROR_MS) return null;
  state.started = state.started.filter(t => now - t < 3_600_000);
  if (state.started.length >= MAX_PER_HOUR) {
    console.warn('Self-repair skipped (hourly limit):', i.error.slice(0, 120));
    return null;
  }
  state.seen[sig] = now;
  for (const [k, t] of Object.entries(state.seen)) if (now - t > SAME_ERROR_MS) delete state.seen[k];
  state.started.push(now);

  const where = {
    task: 'A background task failed with this error',
    chat: 'The chat request failed with this error',
    client: 'The Jarvis app in the browser threw this error',
    crash: 'The Jarvis server crashed. Its last output',
    rollback: 'Your last self-modification patch kept the server from starting, so the supervisor rolled it back. The error',
  }[i.source];
  const task = startRun({
    title: 'Self-repair: ' + i.error.split('\n')[0].slice(0, 70),
    app: 'Jarvis', mode: 'CLI',
    goal: `Self-repair. ${where}:\n\n${i.error.slice(0, 4000)}${i.context ? `\n\nContext:\n${i.context.slice(0, 2000)}` : ''}

Find the root cause in your own source code and fix it:
1. Read the server log (${LOG}) and the source files involved (start from the stack trace or the feature named in the error).
2. If the cause is outside your code (network, rate limits, the API key or account, the user's PC or a website), don't patch anything. Report what the user should do.
3. Otherwise fix the cause, not the symptom, in your workspace (self_workspace, then self_propose_patch), check it with self_test, and call self_release. The user approves the diff, and it goes live when they're idle.${i.source === 'rollback' ? ' The rolled-back update is in the self_list_patches history: take a different approach this time.' : ''}
4. Don't redo the failed task's side effects (sending, paying, deleting). Report what you fixed and whether the user should retry the original request.`,
  });
  state.repairTasks = [...state.repairTasks.slice(-50), task.id];
  save();
  return task.id;
}

/** Wires task failures to self-repair and picks up crashes and rollbacks left by the supervisor. */
export function startAutofix() {
  onRunFailed((task, e) => {
    if (!isOwnBug(e)) return;
    reportIncident({ source: 'task', error: e instanceof Error ? (e.stack || e.message) : String(e), context: `Task: ${task.title}\nGoal: ${task.goal ?? ''}`, taskId: task.id });
  });
  if (!existsSync(INCIDENT_FILE)) return;
  try {
    const list = JSON.parse(readFileSync(INCIDENT_FILE, 'utf8')) as Incident[];
    rmSync(INCIDENT_FILE, { force: true });
    for (const x of list) reportIncident({ source: x.kind, error: x.error, context: x.patch ? `Patch ${x.patch}: ${x.summary}` : undefined });
  } catch (e) {
    console.error('Could not read incidents:', e);
  }
}
