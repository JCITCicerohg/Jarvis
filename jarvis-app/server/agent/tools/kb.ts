import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../../paths.ts';
import { runSql } from './analytics.ts';
import { num, parser, short, str, tool, type ToolSpec } from './spec.ts';

/* ── Knowledge_Base: the company-document knowledge base (kb-service). Jarvis only holds an API key. ── */

export const kbConfigured = () => !!process.env.KB_API_URL && !!process.env.KB_API_KEY;

async function kb(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  if (!kbConfigured()) throw new Error('The knowledge base is not configured. Set KB_API_URL and KB_API_KEY in .env.');
  const res = await fetch(process.env.KB_API_URL!.replace(/\/+$/, '') + path, {
    method: init.method ?? 'GET',
    headers: { Authorization: 'Bearer ' + process.env.KB_API_KEY, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
];
