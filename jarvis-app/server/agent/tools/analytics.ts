import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { resolvePath } from './os.ts';
import { sqlWriteReason } from './risk.ts';
import { parser, short, str, tool, type ToolSpec } from './spec.ts';

const MAX_ROWS = 200;
let conn: Promise<DuckDBConnection> | null = null;

/** One in-memory DuckDB per server session; views and tables persist between calls. */
function db() {
  conn ??= (async () => {
    const inst = await DuckDBInstance.create(':memory:');
    const c = await inst.connect();
    try { await c.run('INSTALL excel; LOAD excel;'); } catch { /* offline: Excel reading unavailable */ }
    return c;
  })();
  return conn;
}

const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\t\n]/g, ' ');

export async function runSql(sql: string): Promise<string> {
  const c = await db();
  const r = await c.runAndReadAll(sql);
  const cols = r.columnNames();
  if (!cols.length) return 'OK';
  const rows = r.getRowObjectsJson();
  const shown = rows.slice(0, MAX_ROWS);
  return [
    `${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} shown; aggregate or LIMIT for more)` : ''}`,
    cols.join('\t'),
    ...shown.map(row => cols.map(k => cell(row[k])).join('\t')),
  ].join('\n');
}

/** Picks the DuckDB reader for a file by extension. */
function reader(path: string) {
  const p = path.replace(/\\/g, '/').replace(/'/g, "''");
  if (/\.(xlsx|xlsm)$/i.test(p)) return `read_xlsx('${p}')`;
  if (/\.json(l)?$/i.test(p)) return `read_json_auto('${p}')`;
  if (/\.parquet$/i.test(p)) return `read_parquet('${p}')`;
  return `read_csv_auto('${p}')`;
}

export const ANALYTICS_TOOLS: ToolSpec<unknown>[] = [
  tool<{ path: string }>({
    def: {
      name: 'analytics_profile',
      description: 'Analytics_Engine: profile a CSV, JSON, Parquet or Excel file: columns, types, row count, min/max, nulls and distinct counts.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    parse: parser(o => ({ path: resolvePath(str(o, 'path')!) })),
    step: i => ({ kind: 'data', text: 'Profiled ' + short(i.path.split(/[\\/]/).pop() ?? i.path, 80) }),
    run: async i => `Source: ${reader(i.path)}\n\n` + await runSql(`SUMMARIZE SELECT * FROM ${reader(i.path)}`),
  }),
  tool<{ sql: string }>({
    def: {
      name: 'analytics_query',
      description: "Analytics_Engine: run DuckDB SQL. Read files directly, e.g. SELECT sku, SUM(qty) FROM read_csv_auto('C:/data/counts.csv') GROUP BY 1, or read_xlsx('…xlsx'), read_json_auto(…). CREATE VIEW/TABLE persist for the session. Writing files (COPY … TO) asks the user first.",
      input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    },
    parse: parser(o => ({ sql: str(o, 'sql')! })),
    step: i => ({ kind: 'data', text: 'Ran analysis: ' + short(i.sql.replace(/\s+/g, ' '), 100) }),
    gate: i => {
      const reason = sqlWriteReason(i.sql);
      return reason ? { action: reason, detail: 'DuckDB will write to disk', risk: 'Irreversible', preview: i.sql } : null;
    },
    run: i => runSql(i.sql),
  }),
];
