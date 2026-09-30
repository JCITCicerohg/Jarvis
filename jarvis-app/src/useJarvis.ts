import { useCallback, useEffect, useRef, useState } from 'react';
import { EDGES, NODES, P, S, clock, seedInteg, seedTasks } from './data';
import type {
  AgentAction, AiProvider, Decision, Integration, IntegrationGroup, KeyStatus, MemMode, MemoryGraph, Message, OrbState, Panel, ServerEvent, SetupInput,
  StartTaskInput, Task, Toast, VoiceSettings,
} from './types';

export interface JarvisState {
  panel: Panel | null;
  sel: string | null;
  messages: Message[];
  input: string;
  busy: boolean;
  listening: boolean;
  speak: boolean;
  orb: OrbState;
  note: string;
  memMode: MemMode;
  memQ: string;
  node: string;
  w: number;
  h: number;
  tasks: Task[];
  integ: IntegrationGroup[];
  toasts: Toast[];
  decisions: Decision[];
  mem: MemoryGraph;
  /** Live mode: whether the session-wide admin grant is active on the server. */
  admin: boolean;
  /** Live mode: whether the event stream is connected. */
  connected: boolean;
  /** AI provider, model and key status from the server (null until loaded), and whether the setup screen is open. */
  key: KeyStatus | null;
  setup: boolean;
  /** Voice turn length and wake word, persisted in localStorage. */
  voice: VoiceSettings;
  /** The conversation's thinking while a reply is on its way. */
  chatThought: string;
  /** The reply as it streams in. */
  chatReply: string;
}


type Update = Partial<JarvisState> | ((s: JarvisState) => Partial<JarvisState> | null);

/* eslint-disable @typescript-eslint/no-explicit-any */
type SpeechRec = any;

// @vitejs/plugin-react only adds Fast Refresh to files with JSX, so hook changes in this .ts file are invisible
// to it. A hot swap that adds or removes a hook keeps App's old hook list and React crashes ("Should have a
// queue"). Reload the page instead whenever this module changes.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

/** Voice turns end only after this much continuous silence (Siri-like end of utterance): 3–5 s, default 3 s. */
export const SILENCE_MIN = 3, SILENCE_MAX = 5;
const VOICE_KEY = 'jarvis.voice';
const VOICE_DEFAULTS: VoiceSettings = { silenceSec: 3, wake: false, wakeWord: 'Hey Jarvis' };
const clampSilence = (n: number) => Math.min(SILENCE_MAX, Math.max(SILENCE_MIN, Number.isFinite(n) ? n : VOICE_DEFAULTS.silenceSec));
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function loadVoice(): VoiceSettings {
  try {
    const v = { ...VOICE_DEFAULTS, ...JSON.parse(localStorage.getItem(VOICE_KEY) || '{}') };
    return { silenceSec: clampSilence(Number(v.silenceSec)), wake: !!v.wake, wakeWord: String(v.wakeWord || '') || VOICE_DEFAULTS.wakeWord };
  } catch { return VOICE_DEFAULTS; }
}

/** The conversation survives a reload (live mode), so Jarvis keeps its context. */
const CHAT_KEY = 'jarvis.chat';
const CHAT_KEEP = 40;
function loadChat(): Message[] {
  try {
    const m = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    return Array.isArray(m) ? m.filter(x => x && typeof x.text === 'string').slice(-CHAT_KEEP) : [];
  } catch { return []; }
}

const initial = (voiceReplies: boolean, live: boolean): JarvisState => ({
  panel: null, sel: null, messages: live ? loadChat() : [], input: '', busy: false, listening: false, speak: voiceReplies, orb: 'idle', note: '',
  memMode: 'Both', memQ: '', node: 'n0', w: window.innerWidth, h: window.innerHeight, integ: seedInteg(),
  mem: { nodes: NODES, edges: EDGES }, admin: false, connected: false, key: null, setup: false, voice: loadVoice(), chatThought: '', chatReply: '',
  ...(live ? { tasks: [], toasts: [], decisions: [] } : {
    tasks: seedTasks(),
    toasts: [{ id: 'x0', kind: 'fix', task: 't1', title: 'Jarvis fixed itself', text: 'BevSpot moved its Export button. I updated my automation and kept going.', at: Date.now() + 4000 }],
    decisions: [{ title: 'Book vendor review meetings for next week', action: 'Send 3 calendar invites', ok: true, time: '9:05 AM' }],
  }),
});

function expireToasts(s: JarvisState): Partial<JarvisState> | null {
  const now = Date.now();
  const kept = s.toasts.filter(x => now - x.at < 8000);
  return kept.length === s.toasts.length ? null : { toasts: kept };
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/** Advances running tasks by one plan step (65% chance each) and expires toasts. */
function tick(s: JarvisState): Partial<JarvisState> | null {
  let changed = false;
  const fresh: Omit<Toast, 'id' | 'at'>[] = [];
  const tasks = s.tasks.map(t => {
    if (t.status !== 'running' || t.paused || !t.plan.length || Math.random() < 0.35) return t;
    changed = true;
    const [n, ...rest] = t.plan;
    if (n.kind === 'approval' && n.approval) {
      fresh.push({ kind: 'approval', task: t.id, title: 'Needs your decision', text: n.approval.action });
      return { ...t, plan: rest, status: 'waiting' as const, approval: n.approval, steps: [...t.steps, S('approval', 'Waiting for your approval: ' + n.approval.action, clock())] };
    }
    const nt: Task = { ...t, plan: rest, steps: [...t.steps, S(n.kind, n.text, clock())] };
    if (n.kind === 'fix') {
      nt.fix = { text: n.fixNote || n.text, time: clock() };
      fresh.push({ kind: 'fix', task: t.id, title: 'Jarvis fixed itself', text: n.text });
    }
    if (!rest.length) {
      nt.status = 'done';
      nt.steps = [...nt.steps, S('done', 'Task complete', clock())];
      fresh.push({ kind: 'done', task: t.id, title: 'Task complete', text: t.title });
    }
    return nt;
  });
  const now = Date.now();
  const kept = s.toasts.filter(x => now - x.at < 8000);
  if (!changed && kept.length === s.toasts.length) return null;
  return {
    tasks: changed ? tasks : s.tasks,
    toasts: [...fresh.map((x, i) => ({ ...x, id: now + '-' + i, at: now })), ...kept].slice(0, 2),
  };
}

function decideIn(s: JarvisState, id: string, ok: boolean): Partial<JarvisState> | null {
  const t = s.tasks.find(x => x.id === id);
  if (!t || t.status !== 'waiting' || !t.approval) return null;
  const a = t.approval;
  const plan = ok ? t.plan : t.plan.slice(1);
  let steps = [...t.steps, S('user', (ok ? 'You approved: ' : 'You declined: ') + a.action, clock())];
  let status: Task['status'] = 'running';
  if (!plan.length) {
    status = 'done';
    steps = [...steps, S('done', 'Task complete', clock())];
  }
  return {
    tasks: s.tasks.map(x => (x.id === id ? { ...x, plan, steps, status, approval: null } : x)),
    decisions: [{ title: t.title, action: a.action, ok, time: clock() }, ...s.decisions],
  };
}

function buildTask(i: StartTaskInput, id: string): Task {
  const mode = i.mode || 'Browser';
  const kind = mode === 'Search' ? 'search' : mode === 'API' ? 'api' : 'browse';
  const steps = (i.steps || []).slice(0, 6);
  const plan = steps.map((txt, k) => P(k === steps.length - 2 ? 'think' : kind, txt));
  if (i.risky_action) {
    const risk = /pay/i.test(i.risky_action) ? 'Pay' : /delet|remov/i.test(i.risky_action) ? 'Delete' : 'Send';
    plan.splice(Math.max(plan.length - 1, 0), 0, P('approval', '', {
      approval: { action: i.risky_action, detail: 'Requested by voice or chat · Jarvis will do this only after you approve', risk },
    }));
  }
  return {
    id, title: i.title, app: i.app || 'Jarvis', mode, url: (i.app || 'Jarvis') + ' › ' + i.title, status: 'running',
    steps: [S('think', 'Planned ' + plan.length + ' steps from your request', clock())], plan,
  };
}

/**
 * App state. `live` = tasks run on the server (real tools, SSE updates);
 * otherwise the prototype's simulated demo runs in the browser.
 */
export function useJarvis(voiceReplies: boolean, live: boolean) {
  const [state, setRaw] = useState<JarvisState>(() => initial(voiceReplies, live));
  const ref = useRef(state);
  ref.current = state;
  const rec = useRef<SpeechRec>(null);
  const endVoice = useRef<(() => void) | null>(null);
  const wakeStop = useRef<(() => void) | null>(null);
  const [, force] = useState(0);

  const set = useCallback((u: Update) => {
    setRaw(s => {
      const patch = typeof u === 'function' ? u(s) : u;
      return patch ? { ...s, ...patch } : s;
    });
  }, []);

  useEffect(() => { set({ speak: voiceReplies }); }, [voiceReplies, set]);

  useEffect(() => {
    if (!live) return;
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(state.messages.slice(-CHAT_KEEP))); } catch { /* storage full or blocked */ }
  }, [state.messages, live]);

  useEffect(() => {
    const iv = setInterval(() => set(live ? expireToasts : tick), 3000);
    const clk = setInterval(() => force(n => n + 1), 15000);
    const onR = () => set({ w: window.innerWidth, h: window.innerHeight });
    const onK = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current.panel) set({ panel: null }); };
    window.addEventListener('resize', onR);
    window.addEventListener('keydown', onK);
    return () => {
      clearInterval(iv); clearInterval(clk);
      window.removeEventListener('resize', onR); window.removeEventListener('keydown', onK);
      const r = rec.current;
      rec.current = null;
      try { r?.abort(); } catch { /* ignore */ }
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
    };
  }, [set, live]);

  const loadMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/memory');
      if (res.ok) set({ mem: (await res.json()) as MemoryGraph });
    } catch { /* keep the last graph */ }
  }, [set]);

  const loadIntegrations = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations');
      if (res.ok) set({ integ: (await res.json()) as IntegrationGroup[] });
    } catch { /* keep the last state */ }
  }, [set]);

  const loadKey = useCallback(async () => {
    try {
      const res = await fetch('/api/setup');
      if (res.ok) {
        const key = (await res.json()) as KeyStatus;
        set(s => ({ key, setup: s.setup || !key.configured }));
      }
    } catch { /* server not up yet; the chat error will say so */ }
  }, [set]);

  useEffect(() => { loadKey(); }, [loadKey]);

  /** Saves the provider, model and (optionally) a new key; the server checks it first. Returns an error message, or '' on success. */
  const saveKey = useCallback(async (input: SetupInput) => {
    try {
      const res = await post('/api/setup', input);
      const data = await res.json();
      if (!res.ok) return (data.error as string) || 'Could not save the key.';
      set({ key: data as KeyStatus, setup: false, note: '' });
      return '';
    } catch {
      return "Couldn't reach the Jarvis server. Is it running?";
    }
  }, [set]);

  /** Model ids the provider offers (with its saved key), for the setup screen's picker. */
  const listModels = useCallback(async (provider: AiProvider, baseUrl = ''): Promise<string[]> => {
    try {
      const res = await fetch('/api/setup/models?' + new URLSearchParams({ provider, baseUrl }));
      return res.ok ? ((await res.json()) as { models: string[] }).models : [];
    } catch {
      return [];
    }
  }, []);

  const toast = useCallback((x: Omit<Toast, 'id' | 'at'>) => {
    const now = Date.now();
    set(s => ({ toasts: [{ ...x, id: now + 't', at: now }, ...s.toasts].slice(0, 2) }));
  }, [set]);

  useEffect(() => {
    if (!live) return;
    const es = new EventSource('/api/events');
    es.onopen = () => set({ connected: true });
    es.onerror = () => set({ connected: false });
    es.onmessage = m => {
      const e = JSON.parse(m.data) as ServerEvent;
      if (e.type === 'snapshot') { set({ tasks: e.tasks, decisions: e.decisions, admin: e.admin }); loadMemory(); loadIntegrations(); }
      // Keep a thought that is still streaming in when the task itself updates.
      else if (e.type === 'task') set(s => ({ tasks: s.tasks.some(t => t.id === e.task.id) ? s.tasks.map(t => (t.id === e.task.id ? { ...e.task, live: t.live } : t)) : [e.task, ...s.tasks] }));
      else if (e.type === 'thought') {
        if (e.task === 'chat') set({ chatThought: e.text });
        else set(s => ({ tasks: s.tasks.map(t => (t.id === e.task ? { ...t, live: e.text || undefined } : t)) }));
      }
      else if (e.type === 'reply') set(s => (s.busy ? { chatReply: e.text } : null));
      else if (e.type === 'toast') toast(e.toast);
      else if (e.type === 'decision') set(s => ({ decisions: [e.decision, ...s.decisions] }));
      else if (e.type === 'memory') loadMemory();
      else if (e.type === 'admin') set({ admin: e.granted });
      else if (e.type === 'integrations') loadIntegrations();
    };
    return () => es.close();
  }, [live, set, toast, loadMemory, loadIntegrations]);

  const decide = useCallback((id: string, ok: boolean) => {
    if (live) post(`/api/tasks/${id}/decide`, { approve: ok }).catch(() => set({ note: "Couldn't reach Jarvis to record that decision." }));
    else set(s => decideIn(s, id, ok));
  }, [set, live]);

  const say = useCallback((text: string) => {
    if (!ref.current.speak || !window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.onend = () => set({ orb: 'idle' });
      set({ orb: 'speaking' });
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }, [set]);

  const answer = useCallback((id: string, text: string) => {
    if (!text.trim()) return;
    post(`/api/tasks/${id}/answer`, { text }).catch(() => set({ note: "Couldn't reach Jarvis to pass on your answer." }));
  }, [set]);

  const applyAction = useCallback((a: AgentAction) => {
    if (a.type === 'memory') { set(s => ({ messages: [...s.messages, { role: 'event', icon: 'ph-graph', text: a.text }] })); return; }
    if (a.type === 'ask') return; // shown as buttons under the reply
    if (a.type === 'answer') { set(s => ({ messages: [...s.messages, { role: 'event', icon: 'ph-chat-circle-dots', text: 'Answered the task: ' + a.answer }] })); return; }
    if (live) {
      // The server already started/decided; just log it in the transcript.
      if (a.type === 'start_task') set(s => ({ messages: [...s.messages, { role: 'event', icon: 'ph-play-circle', text: 'Started task: ' + a.input.title }] }));
      return;
    }
    if (a.type === 'decide') { decide(a.task_id, a.approve); return; }
    if (a.type !== 'start_task') return;
    const t = buildTask(a.input, a.id);
    set(s => ({ tasks: [t, ...s.tasks], messages: [...s.messages, { role: 'event', icon: 'ph-play-circle', text: 'Started task: ' + t.title }] }));
    toast({ kind: 'start', task: a.id, title: 'Started a task', text: t.title });
  }, [decide, set, toast, live]);

  const send = useCallback(async (raw?: string) => {
    const s = ref.current;
    const text = (raw ?? s.input).trim();
    if (!text || s.busy) return;
    const msgs: Message[] = [...s.messages, { role: 'user', text }];
    set({ messages: msgs, input: '', busy: true, orb: 'thinking', note: '' });
    const tasks = s.tasks.map(t => ({
      id: t.id, title: t.title, status: t.status, paused: !!t.paused,
      approval: t.status === 'waiting' && t.approval ? t.approval.action : null,
      lastStep: (t.steps[t.steps.length - 1] || { text: '' }).text,
    }));
    let reply: string;
    let options: string[] = [];
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs.filter(m => m.role !== 'event').map(m => ({ role: m.role, text: m.text })),
          live, tasks: live ? undefined : tasks, clock: clock(),
        }),
      });
      if (res.status === 409) {
        set(st => ({ messages: [...st.messages, { role: 'assistant', text: 'I need an API key for your AI provider before I can answer. Add one in setup.' }], busy: false, orb: 'idle', chatThought: '', chatReply: '', setup: true, key: st.key && { ...st.key, configured: false } }));
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as { reply: string; actions: AgentAction[] };
      data.actions.forEach(applyAction);
      const ask = data.actions.find((x): x is Extract<AgentAction, { type: 'ask' }> => x.type === 'ask');
      options = ask?.options ?? [];
      reply = (data.reply || '').trim() || ask?.question || 'Done.';
    } catch {
      reply = "I couldn't reach the model just now. Try again in a moment.";
    }
    set(st => ({ messages: [...st.messages, { role: 'assistant', text: reply, ...(options.length ? { options } : {}) }], busy: false, orb: 'idle', chatThought: '', chatReply: '' }));
    say(reply);
  }, [applyAction, say, set]);

  /** Starts a voice turn. `seed` is text already heard (e.g. words after the wake word). */
  const listen = useCallback((seed: string) => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { set({ note: "Voice input isn't available in this browser. Type instead." }); return; }
    wakeStop.current?.(); // only one recognizer can hold the mic
    // Siri-like: pauses, breaths and "um"s don't end the turn. Any speech or interim result resets the
    // silence timer, and the engine is restarted if it ends on its own, keeping the words heard so far.
    let kept = seed, heard = '', done = false, fatal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const text = () => (kept + ' ' + heard).replace(/\s+/g, ' ').trim();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      endVoice.current = null;
      const r = rec.current;
      rec.current = null;
      try { r?.stop(); } catch { /* ignore */ }
      set(s => ({ listening: false, orb: s.busy ? 'thinking' : 'idle' }));
      const t = text();
      if (t) send(t);
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(finish, clampSilence(ref.current.voice.silenceSec) * 1000); };
    const start = () => {
      const r = new SR();
      r.lang = 'en-US';
      r.continuous = true;
      r.interimResults = true;
      r.onspeechstart = arm;
      r.onresult = (e: any) => {
        if (done) return;
        heard = Array.from(e.results as ArrayLike<any>).map(x => x[0].transcript).join('');
        set({ input: text() });
        arm();
      };
      r.onerror = (e: any) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return; // onend restarts it
        fatal = true;
        set({ note: e.error === 'not-allowed' ? 'Microphone access was blocked. Type instead.' : 'Voice input stopped: ' + e.error });
      };
      r.onend = () => {
        if (done || rec.current !== r) return;
        kept = text(); heard = '';
        if (fatal) { finish(); return; }
        try { start(); } catch { finish(); }
      };
      rec.current = r;
      r.start();
    };
    try { start(); set({ listening: true, orb: 'listening', note: '', input: seed }); arm(); endVoice.current = finish; } catch { /* ignore */ }
  }, [send, set]);

  const toggleMic = useCallback(() => {
    if (ref.current.listening) { endVoice.current?.(); return; }
    listen('');
  }, [listen]);

  // Wake word: while Jarvis is idle, a background recognizer waits for the phrase, then hands off to a normal
  // voice turn. It pauses while you talk, Jarvis thinks or Jarvis speaks, so it never hears its own replies.
  const { wake, wakeWord } = state.voice;
  const idleForWake = !state.listening && !state.busy && state.orb !== 'speaking';
  useEffect(() => {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    const phrase = norm(wakeWord);
    if (!wake || !idleForWake || !SR || !phrase) return;
    let stopped = false;
    let r: SpeechRec = null;
    const stop = () => { stopped = true; if (wakeStop.current === stop) wakeStop.current = null; try { r?.abort(); } catch { /* ignore */ } };
    const start = () => {
      r = new SR();
      r.lang = 'en-US';
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e: any) => {
        const said = norm(Array.from(e.results as ArrayLike<any>).map(x => x[0].transcript).join(' '));
        const at = (' ' + said + ' ').indexOf(' ' + phrase + ' ');
        if (at < 0 || stopped) return;
        stop();
        listen(said.slice(at + phrase.length).trim());
      };
      r.onerror = (e: any) => {
        if (e.error === 'no-speech') return; // onend restarts it
        stopped = true;
        if (e.error === 'not-allowed') set({ note: 'Microphone access was blocked, so the wake word is paused.' });
      };
      r.onend = () => { if (!stopped) { try { start(); } catch { /* ignore */ } } };
      r.start();
    };
    wakeStop.current = stop;
    try { start(); } catch { /* ignore */ }
    return stop;
  }, [wake, wakeWord, idleForWake, listen, set]);

  const setVoice = useCallback((patch: Partial<VoiceSettings>) => {
    set(s => {
      const voice = { ...s.voice, ...patch };
      voice.silenceSec = clampSilence(voice.silenceSec);
      try { localStorage.setItem(VOICE_KEY, JSON.stringify(voice)); } catch { /* ignore */ }
      return { voice };
    });
  }, [set]);

  const toggleSpeak = useCallback(() => {
    const on = ref.current.speak;
    if (on) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
    set({ speak: !on, orb: 'idle' });
  }, [set]);

  const setIntegration = useCallback((id: string, patch: Partial<Integration>) => {
    if (live) {
      post(`/api/integrations/${id}`, { on: patch.on, pref: patch.pref }).catch(() => set({ note: "Couldn't reach Jarvis to update that app." }));
      return;
    }
    set(s => ({ integ: s.integ.map(g => ({ ...g, items: g.items.map(it => (it.id === id ? { ...it, ...patch } : it)) })) }));
  }, [set, live]);

  const togglePause = useCallback((id: string) => {
    if (live) post(`/api/tasks/${id}/pause`).catch(() => undefined);
    else set(s => ({ tasks: s.tasks.map(x => (x.id === id ? { ...x, paused: !x.paused } : x)) }));
  }, [set, live]);

  const stopAll = useCallback(() => { post('/api/stop').catch(() => undefined); }, []);

  const applyUpdate = useCallback(() => {
    post('/api/self/apply').then(r => r.json()).then(d => set({ note: d.message || d.error || '' })).catch(() => set({ note: "Couldn't reach Jarvis to apply the update." }));
  }, [set]);

  const revokeAdmin = useCallback(() => {
    if (window.confirm('End the admin session? Jarvis will need to ask again before running elevated commands.')) post('/api/admin/revoke').catch(() => undefined);
  }, []);

  return { state, set, live, saveKey, listModels, applyUpdate, decide, answer, send, toggleMic, toggleSpeak, setVoice, setIntegration, togglePause, stopAll, revokeAdmin };
}

export type Jarvis = ReturnType<typeof useJarvis>;
