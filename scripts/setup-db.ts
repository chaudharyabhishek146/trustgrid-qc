/**
 * Applies db/schema.sql, db/views.sql and db/seed.sql.
 *   npm run db:setup            -- create if absent, always refresh views+seed
 *   npm run db:setup -- --reset -- drop everything first
 */
try { process.loadEnvFile?.('.env'); } catch { /* optional */ }

import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/trustgrid';
const reset = process.argv.includes('--reset');

const sql = (f: string) => readFileSync(new URL(`../db/${f}`, import.meta.url), 'utf8');

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();
  console.log(`connected: ${url.replace(/:[^:@]+@/, ':***@')}`);

  if (reset) {
    console.log('dropping schema…');
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  const { rows } = await client.query(
    `SELECT to_regclass('public.inspections') IS NOT NULL AS present`,
  );
  if (rows[0].present && !reset) {
    console.log('tables already present — skipping schema.sql (use --reset to rebuild)');
  } else {
    console.log('applying schema.sql…');
    await client.query(sql('schema.sql'));
  }

  console.log('applying views.sql…');
  await client.query(sql('views.sql'));
  console.log('applying seed.sql…');
  await client.query(sql('seed.sql'));

  const counts = await client.query(
    `SELECT (SELECT COUNT(*) FROM suppliers) AS suppliers,
            (SELECT COUNT(*) FROM sites) AS sites,
            (SELECT COUNT(*) FROM inspections) AS inspections`,
  );
  console.log('✓ ready:', counts.rows[0]);
  await client.end();
}

main().catch((err) => { console.error('setup failed:', err.message); process.exit(1); });
