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

async function testRemoval() {
  try {
    const pool = await mssql.connect(config);
    const ts = '2026-05-11 02:00:30.005';
    
    console.log('Inserting deactivation with Quality = 1...');
    // We'll use the 'Quality' column directly if possible, or OPCQuality = 0
    // Actually, let's try to insert into AnalogHistory if it allows it
    await pool.request().query(`
      INSERT INTO History (TagName, DateTime, Value, OPCQuality)
      VALUES ('Kagome_AU.BR_WQ001_PV', '${ts}', NULL, 0)
    `);
    
    console.log('Verifying result...');
    const res = await pool.request().query(`
      SELECT DateTime, Value, Quality, OPCQuality
      FROM History
      WHERE TagName = 'Kagome_AU.BR_WQ001_PV'
      AND DateTime = '${ts}'
      AND wwRetrievalMode = 'Full'
    `);
    console.log(res.recordset);
    await mssql.close();
  } catch (err) {
    console.error(err);
  }
}

testRemoval();
