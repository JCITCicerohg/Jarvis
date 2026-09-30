import { createPool, type Db } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://kb:kb@localhost:5433/kb_test';

/** Drops and recreates every kb schema in the test database. */
export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DB);
  await db.query('DROP SCHEMA IF EXISTS kb_meta CASCADE; DROP SCHEMA IF EXISTS kb_g1 CASCADE;');
  await migrate(db, 'fake-hash', 384);
  return db;
}
