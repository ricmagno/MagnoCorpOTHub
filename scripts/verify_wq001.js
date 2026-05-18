const mssql = require('mssql');

const config = {
  user: 'historian',
  password: '8&(@Zb7RETf2fw8O21*!Ok^1@%GaI2jy',
  server: '192.168.235.17',
  database: 'Runtime',
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

async function verify() {
  try {
    const pool = await mssql.connect(config);
    console.log('Running user query exactly...');
    const res = await pool.request().query(`
      SELECT
          TagName,
          DateTime,
          Value,
          Quality
      FROM History
      WHERE TagName LIKE 'Kagome_AU.BR_WQ001_PV'
      AND DateTime >= '2026-05-11 02:00:00'
      AND DateTime <= '2026-05-11 14:48:00'
      AND Value = 335000
      ORDER BY DateTime, TagName;
    `);
    console.log('Rows returned:', res.recordset.length);
    if (res.recordset.length > 0) {
        console.log('Sample rows:', res.recordset.slice(0, 5));
    } else {
        console.log('SUCCESS: No rows returned for Value = 335000 in default mode.');
    }
    await mssql.close();
  } catch (err) {
    console.error(err);
  }
}

verify();
