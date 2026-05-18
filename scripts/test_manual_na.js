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

async function testManualNA() {
  try {
    const pool = await mssql.connect(config);
    const ts = '2026-05-11 08:00:00.000';
    const tag = 'Kagome_AU.BR_WQ001_PV';
    const tagKey = 1382;
    
    console.log(`Inserting NULL into ManualAnalogHistory for ${ts}...`);
    try {
      await pool.request().query(`
        INSERT INTO ManualAnalogHistory (TagName, DateTime, Value, Quality, QualityDetail, wwTagKey)
        VALUES ('${tag}', '${ts}', NULL, 1, 0, ${tagKey})
      `);
      console.log('Insert successful!');
    } catch (e) {
      console.log('Insert failed:', e.message);
    }
    
    console.log('Verifying result in standard History view...');
    const res = await pool.request().query(`
      SELECT DateTime, Value, Quality, OPCQuality
      FROM History
      WHERE TagName = '${tag}'
      AND DateTime = '${ts}'
      AND wwRetrievalMode = 'Cyclic'
      AND wwResolution = 60000
    `);
    console.log(res.recordset);
    
    await mssql.close();
  } catch (err) {
    console.error(err);
  }
}

testManualNA();
