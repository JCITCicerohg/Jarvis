import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent, Task } from '../src/types.ts';

let store: typeof import('./state.ts').store;

beforeAll(async () => {
  process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), 'jarvis-state-'));
  ({ store } = await import('./state.ts'));
});

const task = (id: string): Task => ({ id, title: 'T', app: 'Jarvis', mode: 'CLI', url: '', status: 'running', steps: [], plan: [] });
const events = () => {
  const seen: ServerEvent[] = [];
  store.on('event', e => seen.push(e));
  return seen;
};

describe('clarifying questions', () => {
  it('waits on the question and resumes with the answer', async () => {
    store.add(task('q1'));
    const pending = store.askQuestion('q1', { text: 'Which hotel?', options: ['Palacio del Rio', 'Riverwalk'] }, new AbortController().signal);
    expect(store.get('q1')).toMatchObject({ status: 'waiting', question: { text: 'Which hotel?' } });
    expect(store.answer('q1', '  Palacio del Rio ')).toBe(true);
    await expect(pending).resolves.toBe('Palacio del Rio');
    expect(store.get('q1')).toMatchObject({ status: 'running', question: null });
    expect(store.get('q1')!.steps.map(s => s.text)).toEqual(['Asked you: Which hotel?', 'You answered: Palacio del Rio']);
  });

  it('refuses an answer when nothing is asked, or an empty one', async () => {
    store.add(task('q2'));
    expect(store.answer('q2', 'yes')).toBe(false);
    const pending = store.askQuestion('q2', { text: 'Go?', options: [] }, new AbortController().signal);
    expect(store.answer('q2', '   ')).toBe(false);
    store.answer('q2', 'yes');
    await pending;
  });

  it('rejects when the task is stopped', async () => {
    store.add(task('q3'));
    const ac = new AbortController();
    const pending = store.askQuestion('q3', { text: 'Go?', options: [] }, ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('thoughts', () => {
  it('streams live text without saving it, then stores the finished thought', () => {
    store.add(task('th'));
    const seen = events();
    store.thought('th', 'Looking at', false);
    store.thought('th', 'Looking at the reviews', false); // throttled: too soon after the last one
    store.thought('th', 'Looking at the reviews page.', true);
    const thoughts = seen.filter((e): e is Extract<ServerEvent, { type: 'thought' }> => e.type === 'thought');
    expect(thoughts.map(e => e.text)).toEqual(['Looking at', '']);
    expect(store.get('th')!.thoughts!.map(t => t.text)).toEqual(['Looking at the reviews page.']);
  });

  it("streams the conversation's thoughts without touching any task", () => {
    const seen = events();
    store.thought('chat', 'Checking memory', true);
    expect(seen).toContainEqual({ type: 'thought', task: 'chat', text: '' });
    expect(store.get('chat')).toBeUndefined();
  });
});
