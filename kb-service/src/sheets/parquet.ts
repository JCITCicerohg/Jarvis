import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { duck, sqlStr } from '../duck.ts';
import type { TidyTable } from './types.ts';

const DUCK_TYPE = { number: 'DOUBLE', date: 'DATE', text: 'VARCHAR' } as const;

export async function writeParquet(table: TidyTable, outPath: string): Promise<void> {
  if (!table.rows.length) throw new Error('writeParquet: table has no rows');
  await mkdir(dirname(outPath), { recursive: true });
  const tmp = outPath + '.ndjson';
  await writeFile(tmp, table.rows.map(r => JSON.stringify(r)).join('\n'));
  const cols = table.columns.map(c => `${sqlStr(c.name)}: ${sqlStr(DUCK_TYPE[c.type])}`).join(', ');
  try {
    const c = await duck();
    await c.run(`COPY (SELECT * FROM read_json(${sqlStr(tmp)}, format = 'newline_delimited', columns = {${cols}})) TO ${sqlStr(outPath)} (FORMAT parquet)`);
  } finally {
    await rm(tmp, { force: true });
  }
}
