import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

let conn: Promise<DuckDBConnection> | null = null;

/** One in-memory DuckDB per process, used to write and query Parquet. */
export const duck = () => (conn ??= DuckDBInstance.create(':memory:').then(i => i.connect()));

/** A single-quoted SQL string literal (paths and names may contain apostrophes). */
export const sqlStr = (s: string) => `'${s.replace(/\\/g, '/').replace(/'/g, "''")}'`;
