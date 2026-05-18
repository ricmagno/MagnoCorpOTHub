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

async function ultimateCleanup() {
  try {
    console.log('Connecting to Historian...');
    const pool = await mssql.connect(config);

    const targetTagName = 'Kagome_AU.BR_WQ001_PV';
    const tagKey = 1382;
    
    // Define boundaries in UTC to match the Historian's internal storage
    const start = new Date('2026-05-11T02:00:00+10:00');
    const end = new Date('2026-05-11T16:00:00+10:00');
    
    const startTimeUTC = start.toISOString().replace('T', ' ').replace('Z', '');
    const endTimeUTC = end.toISOString().replace('T', ' ').replace('Z', '');

    console.log(`Range: ${startTimeUTC} to ${endTimeUTC} (UTC)`);

    console.log('Clearing existing manual entries...');
    await pool.request().query(`
      DELETE FROM ManualAnalogHistory 
      WHERE TagName = '${targetTagName}' 
      AND DateTime >= '${startTimeUTC}' 
      AND DateTime <= '${endTimeUTC}'
    `);

    // 1. Fetch ALL actual storage timestamps
    const fetchQuery = `
      SELECT DISTINCT DateTime
      FROM History
      WHERE TagName = '${targetTagName}'
      AND DateTime >= '${startTimeUTC}'
      AND DateTime <= '${endTimeUTC}'
      AND (Value < 300000 OR Value = 305000 OR Value = 320000 OR Value = 335000 OR Value = 345000 OR Value IS NULL)
    `;
    
    console.log('Fetching storage timestamps for N/A masking...');
    const fetchRes = await pool.request().query(fetchQuery);
    const storageTimestamps = fetchRes.recordset.map(r => r.DateTime);
    
    // 2. Generate minute-aligned timestamps
    console.log('Generating minute-aligned timestamps...');
    const alignedTimestamps = [];
    let current = new Date(start);
    while (current <= end) {
      alignedTimestamps.push(new Date(current));
      current.setMinutes(current.getMinutes() + 1);
    }

    // Combine all timestamps and remove duplicates
    const allTimestampsSet = new Set();
    storageTimestamps.forEach(t => allTimestampsSet.add(t.toISOString()));
    alignedTimestamps.forEach(t => allTimestampsSet.add(t.toISOString()));

    const sortedTimestamps = Array.from(allTimestampsSet).sort().map(t => new Date(t));

    console.log(`Total unique timestamps to mask: ${sortedTimestamps.length}`);

    if (sortedTimestamps.length === 0) {
      console.log('No timestamps found.');
      await mssql.close();
      return;
    }

    // 3. Mass Insert into ManualAnalogHistory
    const batchSize = 100;
    for (let i = 0; i < sortedTimestamps.length; i += batchSize) {
      const batch = sortedTimestamps.slice(i, i + batchSize);
      console.log(`Masking batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(sortedTimestamps.length / batchSize)}...`);
      
      let insertQuery = 'INSERT INTO ManualAnalogHistory (TagName, DateTime, Value, Quality, QualityDetail, wwTagKey) VALUES ';
      batch.forEach((ts, index) => {
        const dateStr = ts.toISOString().replace('T', ' ').replace('Z', '');
        insertQuery += `('${targetTagName}', '${dateStr}', NULL, 1, 0, ${tagKey})${index === batch.length - 1 ? ';' : ','}`;
      });

      await pool.request().query(insertQuery);
    }

    console.log('--- Ultimate N/A Masking Completed ---');
    await mssql.close();
  } catch (err) {
    console.error('Error during ultimate cleanup:', err);
    if (mssql) await mssql.close();
  }
}

ultimateCleanup();
