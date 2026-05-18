const mssql = require('mssql');

const config = {
  user: 'historian',
  password: '***REMOVED-LEAKED-AVEVA-DB-PASSWORD-ROTATED***',
  server: '192.168.235.17',
  database: 'Runtime',
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

async function testOffsetRemoval() {
  try {
    const pool = await mssql.connect(config);
    const targetTagName = 'Kagome_AU.BR_WQ001_PV';
    
    // We'll target the 08:00:00 minute which we know has bad data
    const ts = '2026-05-11 08:00:59.999';
    
    console.log(`Inserting Bad Quality record at the END of the minute: ${ts}`);
    await pool.request().query(`
      INSERT INTO History (TagName, DateTime, Value, OPCQuality)
      VALUES ('${targetTagName}', '${ts}', NULL, 0)
    `);
    
    console.log('Verifying with Cyclic query at 1-minute resolution...');
    const res = await pool.request().query(`
      SELECT DateTime, Value, Quality
      FROM History
      WHERE TagName = '${targetTagName}'
      AND DateTime = '2026-05-11 08:00:00'
      AND wwRetrievalMode = 'Cyclic'
      AND wwResolution = 60000
    `);
    console.log(res.recordset);
    await mssql.close();
  } catch (err) {
    console.error(err);
  }
}

testOffsetRemoval();
