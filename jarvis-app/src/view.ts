import { KIND_ICON, MODE_ICON } from './data';
import type { Task } from './types';

export interface TaskVm {
  id: string;
  title: string;
  app: string;
  mode: string;
  modeIcon: string;
  current: string;
  progress: string;
  statusLabel: string;
  dot: string;
  hasFix: boolean;
  fixTime?: string;
  fixText?: string;
  isWaiting: boolean;
  action?: string;
  detail?: string;
  risk?: string;
  preview?: string;
  isQuestion: boolean;
  question?: string;
  why?: string;
  options: string[];
  /** The latest thought (streaming or finished), and whether it is still streaming. */
  thought?: string;
  thinking: boolean;
}

export function taskVm(t: Task): TaskVm {
  const last = t.steps[t.steps.length - 1];
  const q = t.status === 'waiting' ? t.question : null;
  const lastThought = t.thoughts?.[t.thoughts.length - 1]?.text;
  const prog = t.status === 'done' ? 100 : Math.round(100 * t.steps.length / (t.steps.length + t.plan.length + 1));
  return {
    id: t.id, title: t.title, app: t.app, mode: t.mode, modeIcon: MODE_ICON(t.mode),
    current: q ? 'Question for you: ' + q.text : t.status === 'waiting' && t.approval ? 'Waiting for you: ' + t.approval.action : last?.text ?? '',
    progress: prog + '%',
    statusLabel: t.paused ? 'Paused' : q ? 'Needs an answer' : { running: 'Running', waiting: 'Needs you', done: 'Done' }[t.status],
    dot: t.status === 'waiting' ? 'var(--color-accent-300)' : t.status === 'done' ? 'var(--color-neutral-600)' : t.paused ? 'var(--color-neutral-500)' : 'var(--color-accent)',
    hasFix: !!t.fix, fixTime: t.fix?.time, fixText: t.fix?.text, isWaiting: t.status === 'waiting',
    action: t.approval?.action, detail: t.approval?.detail, risk: t.approval?.risk, preview: t.approval?.preview,
    isQuestion: !!q, question: q?.text, why: q?.why, options: q?.options ?? [],
    thought: t.status === 'done' ? undefined : t.live || lastThought, thinking: !!t.live,
  };
}

export function taskDetail(t: Task) {
  const n = t.steps.length;
  const live = t.status === 'running' && !t.paused;
  return {
    ...taskVm(t),
    url: t.url,
    report: t.report,
    steps: t.steps.map((x, k) => ({
      icon: KIND_ICON[x.kind] || 'ph-dot', text: x.text, time: x.time,
      color: x.kind === 'fix' || x.kind === 'error' ? 'var(--color-accent-400)'
        : (x.kind === 'approval' || x.kind === 'user') ? 'var(--color-accent-300)'
        : k === n - 1 && t.status === 'running' ? 'var(--color-accent)' : 'var(--color-neutral-500)',
      textColor: k === n - 1 ? 'var(--color-text)' : 'var(--color-neutral-300)',
    })),
    thoughts: [...(t.thoughts ?? []), ...(t.live ? [{ text: t.live, time: 'now', live: true }] : [])],
    upcoming: t.plan.map(x => ({ text: x.kind === 'approval' && x.approval ? 'Ask you: ' + x.approval.action : x.text })),
    nowLabel: t.status === 'waiting' && t.question ? 'Waiting for your answer' : t.status === 'waiting' ? 'Paused for your decision' : t.status === 'done' ? 'Finished' : t.paused ? 'Paused' : 'Now',
    liveLabel: live ? '● Live' : t.status === 'done' ? 'Ended' : 'Holding',
    liveColor: live ? 'var(--color-accent)' : 'var(--color-neutral-500)',
    canPause: t.status === 'running',
    pauseLabel: t.paused ? 'Resume' : 'Pause',
    pauseIcon: t.paused ? 'ph-play' : 'ph-pause',
  };
}

export type TaskDetail = ReturnType<typeof taskDetail>;
