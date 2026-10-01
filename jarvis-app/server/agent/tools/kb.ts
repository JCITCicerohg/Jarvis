import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../../paths.ts';
import { runSql } from './analytics.ts';
import { num, parser, short, str, tool, type ToolSpec } from './spec.ts';

/* ── Knowledge_Base: the company-document knowledge base (kb-service). Jarvis only holds an API key. ── */

export const kbConfigured = () => !!process.env.KB_API_URL && !!process.env.KB_API_KEY;

async function kb(path: string, init: { method?: string; body?: unknown } = {}, key = process.env.KB_API_KEY): Promise<Response> {
  if (!kbConfigured()) throw new Error('The knowledge base is not configured. Set KB_API_URL and KB_API_KEY in .env.');
  const res = await fetch(process.env.KB_API_URL!.replace(/\/+$/, '') + path, {
    method: init.method ?? 'GET',
    headers: { Authorization: 'Bearer ' + key, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep status text */ }
    throw new Error(`Knowledge base ${res.status}: ${msg}`);
  }
  return res;
}

export async function kbQuery(question: string): Promise<string> {
  return JSON.stringify(await (await kb('/v1/query', { method: 'POST', body: { question } })).json());
}

export async function kbSearch(query: string, k = 8): Promise<string> {
  return JSON.stringify(await (await kb('/v1/search', { method: 'POST', body: { query, k } })).json());
}

/** Downloads tidy datasets as Parquet and registers each as a DuckDB view for analytics_query. */
export async function kbFetchDataset(ids: number[]): Promise<string> {
  const dir = join(DATA_DIR, 'kb');
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  for (const id of ids) {
    const file = join(dir, `dataset-${id}.parquet`);
    await writeFile(file, Buffer.from(await (await kb(`/v1/datasets/${id}/file`)).arrayBuffer()));
    const view = `kb_dataset_${id}`;
    await runSql(`CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_parquet('${file.replace(/\\/g, '/').replace(/'/g, "''")}')`);
    lines.push(`${view}:\n${await runSql(`DESCRIBE ${view}`)}`);
  }
  return `Registered ${ids.length} view(s). Query them with analytics_query, e.g. SELECT * FROM ${`kb_dataset_${ids[0]}`} LIMIT 10.\n\n` + lines.join('\n\n');
}

async function kbAdmin(path: string, init: { method?: string; body?: unknown } = {}): Promise<string> {
  if (!process.env.KB_ADMIN_KEY) throw new Error('Knowledge-base admin is not configured. Set KB_ADMIN_KEY in .env.');
  return JSON.stringify(await (await kb(path, init, process.env.KB_ADMIN_KEY)).json());
}
export const kbGenerations = () => kbAdmin('/v1/admin/generations');
export const kbBuild = () => kbAdmin('/v1/admin/generations', { method: 'POST' });
export const kbCutover = (generation: number) => kbAdmin('/v1/admin/cutover', { method: 'POST', body: { generation } });
export const kbRollback = () => kbAdmin('/v1/admin/rollback', { method: 'POST' });

export async function kbCorrect(message: string, scope: 'global' | 'personal' = 'global'): Promise<string> {
  return JSON.stringify(await (await kb('/v1/corrections', { method: 'POST', body: { message, scope } })).json());
}
export async function kbCorrections(status?: string): Promise<string> {
  return JSON.stringify(await (await kb('/v1/corrections' + (status ? `?status=${encodeURIComponent(status)}` : '?'))).json());
}
export async function kbDecideCorrection(id: number, decision: 'approve' | 'reject' | 'keep' | 'retire'): Promise<string> {
  const path = `/v1/corrections/${id}/decide`, init = { method: 'POST', body: { decision } };
  return decision === 'approve' || decision === 'reject' ? kbAdmin(path, init) : JSON.stringify(await (await kb(path, init)).json());
}

const RESULT_HELP = 'Returns Result JSON: answer_data (calculated rows), passages or files (with file, page and SharePoint link), sources, coverage.missing (periods with no data), notes and confidence. Answer only from it, cite the file and link, and state missing periods and notes plainly.';

export const KB_TOOLS: ToolSpec<unknown>[] = [
  tool<{ question: string }>({
    def: {
      name: 'kb_query',
      description: `Knowledge_Base: answer a question from the company's SharePoint documents and spreadsheets (reports, GLs, labor, guest scores, trackers). Pass the user's question in plain words, with any hotel, department and dates they gave. ${RESULT_HELP}`,
      input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    },
    parse: parser(o => ({ question: str(o, 'question')! })),
    step: i => ({ kind: 'memory', text: 'Searched the knowledge base: ' + short(i.question, 90) }),
    run: i => kbQuery(i.question),
  }),
  tool<{ query: string; k?: number }>({
    def: {
      name: 'kb_search',
      description: 'Knowledge_Base: direct passage search over company documents, without planning. Use when you already know the exact terms to look for.',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number', description: 'Passages to return, default 8, max 30' } }, required: ['query'] },
    },
    parse: parser(o => ({ query: str(o, 'query')!, k: num(o, 'k') })),
    step: i => ({ kind: 'memory', text: 'Searched knowledge-base passages: ' + short(i.query, 90) }),
    run: i => kbSearch(i.query, i.k),
  }),
  tool<{ ids: number[] }>({
    def: {
      name: 'kb_fetch_dataset',
      description: 'Knowledge_Base: download tidy spreadsheet datasets (ids from kb_query sources or answer data) as DuckDB views named kb_dataset_<id>, for follow-up analysis with analytics_query.',
      input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
    },
    parse: parser(o => {
      const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is number => Number.isInteger(x)) : [];
      if (!ids.length) throw new Error('"ids" must be a non-empty list of dataset ids');
      return { ids: ids.slice(0, 24) };
    }),
    step: i => ({ kind: 'data', text: `Loaded ${i.ids.length} knowledge-base dataset(s) for analysis` }),
    run: i => kbFetchDataset(i.ids),
  }),
  tool<Record<string, never>>({
    def: {
      name: 'kb_generations',
      description: 'Knowledge_Base admin: list knowledge-base generations (active, candidate being built or ready, retired), with build progress, eval hit@5 and gate notes.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: parser(() => ({})),
    step: () => ({ kind: 'memory', text: 'Checked knowledge-base generations' }),
    run: () => kbGenerations(),
  }),
  tool<Record<string, never>>({
    def: {
      name: 'kb_build',
      description: 'Knowledge_Base admin: start rebuilding the knowledge base into a new generation (after a rule change such as chunking, parsing or the embedding model). The live generation keeps answering; check progress with kb_generations.',
      input_schema: { type: 'object', properties: {} },
    },
    parse: parser(() => ({})),
    step: () => ({ kind: 'memory', text: 'Started a knowledge-base rebuild' }),
    run: () => kbBuild(),
  }),
  tool<{ generation: number }>({
    def: {
      name: 'kb_cutover',
      description: 'Knowledge_Base admin: switch answers to a generation whose status is ready. Takes seconds; roll back with kb_rollback for 7 days.',
      input_schema: { type: 'object', properties: { generation: { type: 'number' } }, required: ['generation'] },
    },
    parse: parser(o => { const g = num(o, 'generation'); if (!Number.isInteger(g)) throw new Error('"generation" must be a whole number'); return { generation: g! }; }),
    step: i => ({ kind: 'memory', text: `Switched the knowledge base to generation ${i.generation}` }),
    gate: i => ({ action: `Switch the knowledge base to generation ${i.generation}`, detail: 'Jarvis will answer from the new generation right away. You can roll back for 7 days.', risk: 'Irreversible' }),
    run: i => kbCutover(i.generation),
  }),
  tool<Record<string, never>>({
    def: {
      name: 'kb_rollback',
      description: 'Knowledge_Base admin: switch answers back to the previously active generation (available for 7 days after a cutover).',
      input_schema: { type: 'object', properties: {} },
    },
    parse: parser(() => ({})),
    step: () => ({ kind: 'memory', text: 'Rolled the knowledge base back' }),
    gate: () => ({ action: 'Roll the knowledge base back to the previous generation', detail: 'Jarvis will answer from the previous generation right away.', risk: 'Irreversible' }),
    run: () => kbRollback(),
  }),
  tool<{ message: string; scope: 'global' | 'personal' }>({
    def: {
      name: 'kb_correct',
      description: 'Knowledge_Base: record the user\'s correction of a fact about company data (e.g. "the lobby renovation slipped to Q4"). Company-wide by default (pending approval, visible to the user right away); scope "personal" if they say it is just for them. Never changes official files. If the result has "clarify", ask the user that question.',
      input_schema: { type: 'object', properties: { message: { type: 'string', description: "The user's words" }, scope: { type: 'string', enum: ['global', 'personal'] } }, required: ['message'] },
    },
    parse: parser(o => {
      const scope = o.scope ?? 'global';
      if (scope !== 'global' && scope !== 'personal') throw new Error('"scope" must be global or personal');
      return { message: str(o, 'message')!, scope };
    }),
    step: i => ({ kind: 'memory', text: 'Saved a knowledge-base correction: ' + short(i.message, 80) }),
    run: i => kbCorrect(i.message, i.scope),
  }),
  tool<{ status?: string }>({
    def: {
      name: 'kb_corrections',
      description: 'Knowledge_Base: list corrections (filter by status: pending, approved, needs_review, rejected, expired). Admins see pending company-wide corrections awaiting approval.',
      input_schema: { type: 'object', properties: { status: { type: 'string' } } },
    },
    parse: parser(o => ({ status: str(o, 'status', false) })),
    step: () => ({ kind: 'memory', text: 'Checked knowledge-base corrections' }),
    run: i => kbCorrections(i.status),
  }),
  tool<{ id: number; decision: 'approve' | 'reject' | 'keep' | 'retire' }>({
    def: {
      name: 'kb_decide_correction',
      description: 'Knowledge_Base: approve or reject a pending company-wide correction (admin), or keep/retire one flagged needs_review. Only when the user decides.',
      input_schema: { type: 'object', properties: { id: { type: 'number' }, decision: { type: 'string', enum: ['approve', 'reject', 'keep', 'retire'] } }, required: ['id', 'decision'] },
    },
    parse: parser(o => {
      const id = num(o, 'id');
      if (!Number.isInteger(id)) throw new Error('"id" must be a whole number');
      const decision = o.decision;
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'keep' && decision !== 'retire') throw new Error('"decision" must be approve, reject, keep or retire');
      return { id: id!, decision };
    }),
    step: i => ({ kind: 'memory', text: `Correction ${i.id}: ${i.decision}` }),
    run: i => kbDecideCorrection(i.id, i.decision),
  }),
];
