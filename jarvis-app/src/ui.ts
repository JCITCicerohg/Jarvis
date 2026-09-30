import type { KeyboardEvent } from 'react';
import { clock } from './data';
import type { FaceState, ModalPanel } from './types';
import type { Jarvis } from './useJarvis';
import { taskVm } from './view';

export interface UiOptions { framed: boolean; hud: boolean }

/** Values and handlers shared by the desktop, mobile, transcript and modal views. */
export function deriveUi(j: Jarvis, { framed, hud }: UiOptions) {
  const { state: s, set } = j;
  const isMobile = framed || s.w < 760;
  const running = s.tasks.filter(t => t.status === 'running');
  const waiting = s.tasks.filter(t => t.status === 'waiting');
  const done = s.tasks.filter(t => t.status === 'done');
  const openTask = (id: string) => set({ sel: id, panel: 'task' });
  const selT = s.tasks.find(t => t.id === s.sel);

  const now = new Date(), hr = now.getHours();
  const greet = hr < 12 ? 'Good morning.' : hr < 18 ? 'Good afternoon.' : 'Good evening.';
  const lastReply = [...s.messages].reverse().find(m => m.role === 'assistant');
  const caption = s.note || (s.listening ? (s.input || 'Listening…') : s.busy ? (s.chatReply || s.chatThought || 'Thinking…') : lastReply ? lastReply.text
    : `${greet} ${waiting.length ? `${waiting.length} decision${waiting.length === 1 ? ' is' : 's are'} waiting on you` : 'Nothing needs you right now'}, and ${running.length} task${running.length === 1 ? ' is' : 's are'} running.`);

  // Tap-to-answer buttons for Jarvis's last clarifying question in the chat.
  const lastMsg = s.messages[s.messages.length - 1];
  const chatOptions = !s.busy && lastMsg?.role === 'assistant' ? lastMsg.options ?? [] : [];
  // The main task: the open one if it's running, else the newest running task that is thinking.
  const focusT = (selT && selT.status !== 'done' ? selT : undefined)
    ?? running.find(t => t.live) ?? running.find(t => t.thoughts?.length) ?? waiting.find(t => t.question);
  const focus = focusT && (() => { const v = taskVm(focusT); return v.thought || v.isQuestion ? { id: v.id, title: v.title, text: v.isQuestion ? 'Waiting for your answer: ' + v.question : v.thought!, live: v.thinking } : null; })();

  const panel = s.panel;
  const modal: ModalPanel | null = panel && panel !== 'transcript' && (panel !== 'task' || selT) ? panel : null;

  const panelFab = (id: ModalPanel, label: string, icon: string, badge = 0) => ({ id, label, icon, badge, go: () => set({ panel: id }) });
  const fabs = [
    ...(j.live && s.admin ? [{ id: 'admin', label: 'Admin on', icon: 'ph-shield-check', badge: 0, go: j.revokeAdmin }] : []),
    ...(j.live && running.length ? [{ id: 'stop', label: 'Stop all', icon: 'ph-stop-circle', badge: 0, go: j.stopAll }] : []),
    panelFab('tasks', 'Tasks', 'ph-list-checks'),
    panelFab('approvals', 'Approvals', 'ph-hand-palm', waiting.length),
    panelFab('memory', 'Memory', 'ph-graph'),
    panelFab('integrations', 'Apps', 'ph-plugs'),
    panelFab('settings', 'Settings', 'ph-gear-six'),
  ];

  const faceState: FaceState = s.listening ? 'listening' : s.busy ? 'thinking' : s.orb === 'speaking' ? 'speaking' : 'idle';

  return {
    s, j, isMobile, framed, hud, selT, modal, openTask, caption, fabs, faceState, chatOptions, focus,
    running: running.map(taskVm), waiting: waiting.map(taskVm), doneCount: done.length,
    allTasks: [...waiting, ...running, ...done].map(taskVm),
    summary: `${running.length} running · ${waiting.length} need you · ${done.length} done today`,
    clock: clock(),
    dateLine: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    faceSize: Math.round(Math.max(260, Math.min(s.h * 0.62, s.w - 620, 680))),
    railW: s.w < 1180 ? 240 : 290,
    orbLabel: s.listening ? 'Listening' : s.busy ? 'Thinking' : s.orb === 'speaking' ? 'Speaking' : `${running.length} running · ${waiting.length} need you`,
    msgCount: s.messages.filter(m => m.role !== 'event').length,
    speakIcon: s.speak ? 'ph-speaker-high' : 'ph-speaker-slash',
    speakLabel: s.speak ? 'Voice replies on' : 'Voice replies off',
    micIcon: s.listening ? 'ph-stop' : 'ph-microphone',
    micBg: s.listening ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)' : 'transparent',
    micGlow: s.listening ? '0 0 28px color-mix(in srgb, var(--color-accent) 60%, transparent)' : '0 0 14px color-mix(in srgb, var(--color-accent) 22%, transparent)',
    placeholder: s.listening ? 'Listening…' : 'Ask Jarvis or hand off a task',
    cantSend: s.busy || !s.input.trim(),
    onInput: (e: { target: { value: string } }) => set({ input: e.target.value }),
    onKey: (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); j.send(); } },
    closePanel: () => set({ panel: null }),
    openTasks: () => set({ panel: 'tasks' }),
    openTranscript: () => set({ panel: 'transcript' }),
  };
}

export type Ui = ReturnType<typeof deriveUi>;
