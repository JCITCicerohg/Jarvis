import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S, clock } from '../src/data.ts';
import type { Approval, Decision, Question, ServerEvent, Step, Task, Toast } from '../src/types.ts';
import { DATA_DIR } from './paths.ts';

const FILE = join(DATA_DIR, 'tasks.json');

interface Pending { resolve: (ok: boolean) => void; reject: (e: Error) => void }
interface PendingQuestion { resolve: (answer: string) => void; reject: (e: Error) => void }
const MAX_THOUGHTS = 40;

/** Server-owned task state. Emits ServerEvents on 'event' and persists to data/tasks.json. */
class Store extends EventEmitter {
  tasks: Task[] = [];
  decisions: Decision[] = [];
  admin = false;
  private pending = new Map<string, Pending>();
  private questions = new Map<string, PendingQuestion>();
  private thoughtAt = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    if (existsSync(FILE)) {
      try {
        const saved = JSON.parse(readFileSync(FILE, 'utf8')) as { tasks: Task[]; decisions: Decision[] };
        // Runs don't survive a restart; close out anything that was in flight.
        this.tasks = saved.tasks.map(t => t.status === 'done' ? t : {
          ...t, status: 'done', approval: null, question: null, plan: [],
          steps: [...t.steps, S('error', 'Interrupted by a server restart', clock())],
          report: t.report ?? { summary: 'Interrupted by a server restart before finishing.', nextSteps: ['Start the task again.'] },
        });
        this.decisions = saved.decisions ?? [];
      } catch (e) {
        console.warn('Could not read tasks.json', e);
      }
    }
  }

  emitEvent(e: ServerEvent) { this.emit('event', e); }

  snapshot(): ServerEvent { return { type: 'snapshot', tasks: this.tasks, decisions: this.decisions, admin: this.admin }; }

  get(id: string) { return this.tasks.find(t => t.id === id); }

  add(t: Task) {
    this.tasks = [t, ...this.tasks];
    this.changed(t);
  }

  update(id: string, fn: (t: Task) => Task): Task | undefined {
    let out: Task | undefined;
    this.tasks = this.tasks.map(t => (t.id === id ? (out = fn(t)) : t));
    if (out) this.changed(out);
    return out;
  }

  step(id: string, step: Step) { return this.update(id, t => ({ ...t, steps: [...t.steps, step] })); }

  toast(toast: Omit<Toast, 'id' | 'at'>) { this.emitEvent({ type: 'toast', toast }); }

  setAdmin(granted: boolean) {
    this.admin = granted;
    this.emitEvent({ type: 'admin', granted });
  }

  /** Puts the task in 'waiting' and resolves true/false once the user decides. */
  async askApproval(id: string, approval: Approval, signal: AbortSignal): Promise<boolean> {
    const t = this.update(id, x => ({ ...x, status: 'waiting', approval, steps: [...x.steps, S('approval', 'Waiting for your approval: ' + approval.action, clock())] }));
    if (!t) return false;
    this.toast({ kind: 'approval', task: id, title: 'Needs your decision', text: approval.action });
    const ok = await new Promise<boolean>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }).finally(() => this.pending.delete(id));
    const decision: Decision = { title: t.title, action: approval.action, ok, time: clock() };
    this.decisions = [decision, ...this.decisions];
    this.emitEvent({ type: 'decision', decision });
    this.update(id, x => ({
      ...x, status: 'running', approval: null,
      steps: [...x.steps, S('user', (ok ? 'You approved: ' : 'You declined: ') + approval.action, clock())],
    }));
    return ok;
  }

  /**
   * Streams a thought to the app. Live text is sent (at most ~3 times a second) without being saved;
   * a finished thought is stored on the task. Use id 'chat' for the conversation.
   */
  thought(id: string, text: string, done: boolean) {
    if (!done) {
      const now = Date.now();
      if (now - (this.thoughtAt.get(id) ?? 0) < 300) return;
      this.thoughtAt.set(id, now);
      this.emitEvent({ type: 'thought', task: id, text });
      return;
    }
    this.thoughtAt.delete(id);
    if (id !== 'chat') this.update(id, t => ({ ...t, thoughts: [...(t.thoughts ?? []), { text, time: clock() }].slice(-MAX_THOUGHTS) }));
    this.emitEvent({ type: 'thought', task: id, text: '' });
  }

  private replyAt = 0;
  /** The chat reply as it streams in (at most ~6 updates a second). */
  replyText(text: string) {
    const now = Date.now();
    if (now - this.replyAt < 150) return;
    this.replyAt = now;
    this.emitEvent({ type: 'reply', text });
  }

  /** Puts the task in 'waiting' with a question and resolves with the user's answer. */
  async askQuestion(id: string, question: Question, signal: AbortSignal): Promise<string> {
    const t = this.update(id, x => ({ ...x, status: 'waiting', question, steps: [...x.steps, S('approval', 'Asked you: ' + question.text, clock())] }));
    if (!t) throw new Error('unknown task');
    this.toast({ kind: 'question', task: id, title: 'Jarvis has a question', text: question.text });
    const answer = await new Promise<string>((resolve, reject) => {
      this.questions.set(id, { resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }).finally(() => this.questions.delete(id));
    this.update(id, x => ({ ...x, status: 'running', question: null, steps: [...x.steps, S('user', 'You answered: ' + answer, clock())] }));
    return answer;
  }

  /** Returns false when the task isn't waiting on a question. */
  answer(id: string, text: string): boolean {
    const q = this.questions.get(id);
    if (!q || !text.trim()) return false;
    q.resolve(text.trim());
    return true;
  }

  /** Returns false when the task has no pending approval. */
  decide(id: string, ok: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.resolve(ok);
    return true;
  }

  private changed(t: Task) {
    this.emitEvent({ type: 'task', task: t });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        writeFileSync(FILE, JSON.stringify({ tasks: this.tasks, decisions: this.decisions }, null, 1));
      } catch (e) {
        console.error('tasks.json write failed', e);
      }
    }, 500);
  }
}

export const store = new Store();
