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

async function testNullGood() {
  try {
    const pool = await mssql.connect(config);
    const ts = '2026-05-11 02:00:30.005';
    
    console.log('Inserting Value = NULL with OPCQuality = 192 (Good)...');
    try {
      await pool.request().query(`
        INSERT INTO History (TagName, DateTime, Value, OPCQuality)
        VALUES ('Kagome_AU.BR_WQ001_PV', '${ts}', NULL, 192)
      `);
      console.log('Insert successful!');
    } catch (e) {
      console.log('Insert failed:', e.message);
    }
    
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

testNullGood();
