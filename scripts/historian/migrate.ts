/**
 * Minimal migration runner for the historian database.
 *
 * - database/init.sql is the fresh-install baseline (runs only on a fresh Postgres
 *   volume via docker-entrypoint-initdb.d) and pre-marks its bundled migrations as
 *   applied in historian.schema_migrations.
 * - This runner brings EXISTING databases up to date: it applies any
 *   database/migrations/*.sql not yet recorded, in filename order, each inside a
 *   transaction.
 */
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import config from '../../src/historian/config';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'database', 'migrations');

async function main() {
  const pool = new Pool({ connectionString: config.database.url });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS historian');
    await pool.query(`CREATE TABLE IF NOT EXISTS historian.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    const applied = new Set(
      (await pool.query('SELECT filename FROM historian.schema_migrations')).rows.map(
        (r: { filename: string }) => r.filename
      )
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO historian.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        client.release();
      }
    }
    console.log(ran === 0 ? 'database up to date' : `done: ${ran} migration(s) applied`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
