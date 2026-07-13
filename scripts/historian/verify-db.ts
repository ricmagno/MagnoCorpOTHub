import { Pool } from 'pg';
import config from '../../src/historian/config';

async function main() {
  const pool = new Pool({ connectionString: config.database.url });
  try {
    const ext = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','timescaledb')"
    );
    if (ext.rows.length < 2) throw new Error('Missing extension: need vector AND timescaledb');
    console.log('extensions ok:', ext.rows.map(r => r.extname).join(', '));

    const dim = await pool.query(
      `SELECT atttypmod AS dim FROM pg_attribute
       WHERE attrelid = 'historian.screenshots'::regclass AND attname = 'embedding'`
    );
    if (dim.rows[0]?.dim !== 512) throw new Error(`embedding dim is ${dim.rows[0]?.dim}, expected 512`);
    console.log('embedding dimension ok: 512');

    const ht = await pool.query(
      `SELECT hypertable_name FROM timescaledb_information.hypertables
       WHERE hypertable_name = 'metrics'`
    );
    if (ht.rows.length === 0) throw new Error('metrics is not a hypertable');
    console.log('hypertable ok: metrics');

    const sys = await pool.query('SELECT count(*) FROM historian.scada_systems');
    console.log('scada systems:', sys.rows[0].count);
    console.log('verification passed');
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
