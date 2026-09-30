import { gschema } from '../db/migrate.ts';
import type { Db } from '../db/pool.ts';
import type { Column } from '../sheets/types.ts';

export interface Catalog {
  hotels: string[]; departments: string[]; fileTypes: string[];
  datasets: { name: string; department: string | null; from: string; to: string; files: number; columns: Column[] | null }[];
}

/** The real filter values the planner may use, from indexed documents in the active generation. */
export async function loadCatalog(db: Db, gen: number): Promise<Catalog> {
  const s = gschema(gen);
  const distinct = async (col: string) =>
    (await db.query(`SELECT DISTINCT ${col} v FROM ${s}.documents WHERE status = 'indexed' AND ${col} IS NOT NULL ORDER BY 1`)).rows.map(r => r.v as string);
  const ds = (await db.query(
    `SELECT d.dataset name, min(d.department) department, min(d.period_start) "from", max(d.period_end) "to", count(*)::int files,
       (SELECT x.columns FROM ${s}.datasets x WHERE x.dataset = d.dataset ORDER BY x.period_end DESC NULLS LAST LIMIT 1) columns
     FROM ${s}.documents d WHERE d.status = 'indexed' AND d.dataset IS NOT NULL GROUP BY d.dataset ORDER BY 1`)).rows;
  return {
    hotels: await distinct('hotel'), departments: await distinct('department'), fileTypes: await distinct('file_type'),
    datasets: ds.map(r => ({ name: r.name, department: r.department, from: r.from, to: r.to, files: r.files, columns: r.columns })),
  };
}
