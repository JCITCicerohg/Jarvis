import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-time Date objects.
pg.types.setTypeParser(1082, v => v);

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** pgvector literal for a bound parameter, used as $n::vector. */
export const vec = (a: number[]) => '[' + a.join(',') + ']';
