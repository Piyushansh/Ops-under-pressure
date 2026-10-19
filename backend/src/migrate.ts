import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

/**
 * Minimal forward-only migration runner: applies migrations/*.sql in name order, each in
 * its own transaction, and records them in schema_migrations. A session-level advisory
 * lock stops two instances migrating at once.
 */
export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const dir = path.resolve(__dirname, '../migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
    await pool.end();
  }
  return applied;
}

if (require.main === module) {
  // Imported lazily so tests can call runMigrations() without needing app config.
  const { config } = require('./config') as typeof import('./config');
  runMigrations(config.DATABASE_URL)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
