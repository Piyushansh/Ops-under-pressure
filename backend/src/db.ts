import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Db {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * Runs fn inside one database transaction (READ COMMITTED). Any thrown error rolls back
 * every write made through the client, which is how item changes and their activity
 * events stay atomic.
 */
export async function withTx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; the original error is more useful */
    }
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
