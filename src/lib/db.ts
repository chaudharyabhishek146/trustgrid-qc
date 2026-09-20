import { Pool } from 'pg';
import { config } from './config';

/**
 * One pool per process. Next.js hot-reload would otherwise leak pools on every
 * edit, so it is stashed on globalThis in development.
 */
const g = globalThis as unknown as { __tgPool?: Pool };

export const pool =
  g.__tgPool ??
  new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== 'production') g.__tgPool = pool;

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run a set of statements in a transaction. Used wherever a write must be
 *  atomic with the job it enqueues. */
export async function tx<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
