export type StepKind = 'browse' | 'api' | 'search' | 'think' | 'fix' | 'approval' | 'user' | 'done' | 'shell' | 'file' | 'memory' | 'error' | 'data';
export type TaskStatus = 'running' | 'waiting' | 'done';
export type Risk = 'Send' | 'Pay' | 'Delete' | 'Admin' | 'Patch' | 'Irreversible';
export type OrbState = 'idle' | 'thinking' | 'listening' | 'speaking';
export type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type Panel = 'transcript' | 'task' | 'tasks' | 'approvals' | 'memory' | 'integrations' | 'settings';
export type ModalPanel = Exclude<Panel, 'transcript'>;
export type MemMode = 'Graph' | 'List' | 'Both';
export type IntegrationPref = 'API first' | 'Browser only' | 'Both';

export interface Step { kind: StepKind; text: string; time: string }
export interface Approval { action: string; detail: string; risk: Risk; preview?: string }
/** A clarifying question a running task put to the user. */
export interface Question { text: string; options: string[]; why?: string }
/** A summary of Jarvis's reasoning or a progress note it wrote between steps. */
export interface Thought { text: string; time: string }
export interface PlanItem { kind: StepKind; text: string; fixNote?: string; approval?: Approval }

export interface Task {
  id: string;
  title: string;
  app: string;
  mode: string;
  url: string;
  status: TaskStatus;
  paused?: boolean;
  steps: Step[];
  plan: PlanItem[];
  approval?: Approval | null;
  /** Waiting on the user's answer to this (status 'waiting'). */
  question?: Question | null;
  /** Jarvis's thinking, oldest first (last 40). */
  thoughts?: Thought[];
  /** Client only: the thought streaming in right now. */
  live?: string;
  fix?: { text: string; time: string };
  /** Live mode: the goal handed to the agent, and its final structured report. */
  goal?: string;
  report?: { summary: string; nextSteps: string[] };
}

export interface Integration {
  id: string;
  name: string;
  icon: string;
  desc: string;
  modes: ('API' | 'Browser')[];
  pref?: IntegrationPref;
  on: boolean;
  last: string;
  /** Live mode: which server engine backs it, whether it can be connected, and a pending sign-in code. */
  engine?: string;
  available?: boolean;
  code?: { userCode: string; verificationUri: string };
  /** Self-modification: an approved update waiting for the user to be idle. */
  update?: { summary: string; files: string[] };
}
export interface IntegrationGroup { g: string; items: Integration[] }

export interface MemNode {
  id: string;
  label: string;
  type: 'Organization' | 'Location' | 'System' | 'Vendor' | 'Person' | 'Project';
  x: number;
  y: number;
  facts: string[];
  source: string;
}

/** Voice preferences, saved in localStorage. silenceSec is clamped to 3–5 s (user rule). */
export interface VoiceSettings { silenceSec: number; wake: boolean; wakeWord: string }

export interface Message { role: 'user' | 'assistant' | 'event'; text: string; icon?: string; options?: string[] }

export type ToastKind = 'fix' | 'approval' | 'done' | 'start' | 'question';
export interface Toast { id: string; kind: ToastKind; task: string; title: string; text: string; at: number }

export interface Decision { title: string; action: string; ok: boolean; time: string }

/** Input shape of the start_task tool, mirrored in server/chat.ts. */
export interface StartTaskInput {
  title: string;
  app?: string;
  mode?: string;
  /** Live mode: what the autonomous run should achieve. */
  goal?: string;
  /** Demo mode: simulated log lines. */
  steps?: string[];
  risky_action?: string;
}

/**
 * Actions the chat tool loop hands back. In demo mode the client applies them to its
 * simulated state; in live mode the server has already applied them and the client
 * only logs them in the transcript.
 */
export type AgentAction =
  | { type: 'start_task'; id: string; input: StartTaskInput }
  | { type: 'decide'; task_id: string; approve: boolean }
  | { type: 'memory'; text: string }
  | { type: 'ask'; question: string; options: string[] }
  | { type: 'answer'; task_id: string; answer: string };

export interface MemoryGraph { nodes: MemNode[]; edges: [string, string][] }

/** AI providers. Anthropic uses its SDK; the others speak the OpenAI chat-completions API. */
export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'azure' | 'compatible';
export interface ProviderInfo {
  id: AiProvider;
  name: string;
  short: string;
  /** Has a key (or needs none). */
  configured: boolean;
  source: 'app' | 'env' | null;
  hint: string;
  model: string;
  defaultModel: string;
  baseUrl: string;
  needsKey: boolean;
  keyUrl: string;
  env: string;
}
/** GET /api/setup: the active provider's key status (top level) plus every provider. */
export interface KeyStatus {
  configured: boolean;
  source: 'app' | 'env' | null;
  hint: string;
  provider: AiProvider;
  model: string;
  providers: ProviderInfo[];
}
/** POST /api/setup. An empty apiKey keeps the saved one; an empty model uses the provider's default. */
export interface SetupInput { provider?: AiProvider; apiKey?: string; model?: string; baseUrl?: string }

/** Server-sent events on GET /api/events (live mode). */
export type ServerEvent =
  | { type: 'snapshot'; tasks: Task[]; decisions: Decision[]; admin: boolean }
  | { type: 'task'; task: Task }
  | { type: 'toast'; toast: Omit<Toast, 'id' | 'at'> }
  | { type: 'decision'; decision: Decision }
  | { type: 'memory' }
  | { type: 'admin'; granted: boolean }
  | { type: 'integrations' }
  /** A thought streaming in. task is a task id, or 'chat' for the conversation; empty text clears it. */
  | { type: 'thought'; task: string; text: string }
  /** The chat reply so far, while it streams in. */
  | { type: 'reply'; text: string };
