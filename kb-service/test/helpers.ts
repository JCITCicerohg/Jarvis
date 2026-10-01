import { createPool, type Db } from '../src/db/pool.ts';
import { migrate, queryUrl } from '../src/db/migrate.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://kb:kb@localhost:5433/kb_test';

/** Drops and recreates every kb schema in the test database. */
export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DB);
  await db.query(`
    DROP SCHEMA IF EXISTS kb_meta CASCADE;
    DO $$ DECLARE s text; BEGIN
      FOR s IN SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'kb\_g%' LOOP
        EXECUTE 'DROP SCHEMA ' || quote_ident(s) || ' CASCADE';
      END LOOP;
    END $$;`);
  await migrate(db, 'fake-hash', 384);
  return db;
}

/** A pool connected as the kb_query role (created by migrate with the default test password). */
export const queryDb = (): Db => createPool(queryUrl(TEST_DB, 'kbquery'));
