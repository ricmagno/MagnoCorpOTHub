const fs = require('fs');
const mssql = require('mssql');

const config = {
  user: 'historian',
  password: '***REMOVED-LEAKED-AVEVA-DB-PASSWORD-ROTATED***',
  server: '192.168.235.17',
  database: 'Runtime',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  connectionTimeout: 60000,
  requestTimeout: 300000 // 5 minutes for large batches
};

const filePath = '/Users/ricmagno/Documents/Projects/KagomeReports/BeetrootData/BR_WQ001_PV.csv';
const targetTagName = 'Kagome_AU.BR_WQ001_PV';

async function restoreData() {
  console.log('--- Start CSV Restore to Historian ---');
  console.log('Reading file:', filePath);
  
  if (!fs.existsSync(filePath)) {
    console.error('File not found!');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  console.log(`Total lines read: ${lines.length}`);

  const dataPoints = [];
  
  const startRange = new Date('2026-05-06T15:34:00.000+10:00');
  const endRange = new Date('2026-05-11T14:54:30.000+10:00');

  for (let i = 1; i < lines.length; i++) { // Skip header
    const line = lines[i].trim();
    if (!line) continue;

    // CSV format: 6/05/2026,15:34:00.000,91816
    const parts = line.split(',');
    if (parts.length < 3) continue;

    const datePart = parts[0];
    const timePart = parts[1];
    let valueStr = parts[2];
    
    // Strip trailing \r if any
    valueStr = valueStr.replace('\r', '');

    const dateSplit = datePart.split('/');
    if (dateSplit.length !== 3) continue;

    const day = dateSplit[0].padStart(2, '0');
    const month = dateSplit[1].padStart(2, '0');
    const year = dateSplit[2];

    // Some times might not have milliseconds, let's normalize
    // User warned: format is different from 'YYYY-MM-DD HH:mm:ss'
    // We will format as 'YYYY-MM-DD HH:mm:ss.SSS' which is what Historian safely eats
    const sqlDateTime = `${year}-${month}-${day} ${timePart}`;
    
    // Validate range
    // timePart might be 15:34:00.000
    const checkDate = new Date(`${year}-${month}-${day}T${timePart}+10:00`);
    
    if (checkDate >= startRange && checkDate <= endRange) {
      const value = parseFloat(valueStr);
      if (!isNaN(value)) {
        dataPoints.push({ timestamp: sqlDateTime, value });
      }
    }
  }

  console.log(`Valid data points in range: ${dataPoints.length}`);

  if (dataPoints.length === 0) {
    console.log('No data points to insert.');
    return;
  }

  try {
    console.log('Connecting to Historian...');
    const pool = await mssql.connect(config);
    console.log('Connected!');

    const batchSize = 100; 
    for (let i = 0; i < dataPoints.length; i += batchSize) {
      const batch = dataPoints.slice(i, i + batchSize);
      console.log(`Inserting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(dataPoints.length / batchSize)}...`);

      const request = new mssql.Request(pool);
      // User specified exact INSERT structure including OPCQuality=192
      let query = 'INSERT INTO History (TagName, DateTime, Value, OPCQuality) VALUES ';
      
      batch.forEach((dp, index) => {
        // We use 192 for Good quality as specified by the user
        query += `('${targetTagName}', '${dp.timestamp}', ${dp.value}, 192)${index === batch.length - 1 ? ';' : ','}`;
      });

      await request.query(query);
    }

    console.log('--- Restore completed successfully! ---');
    await mssql.close();
  } catch (err) {
    console.error('Database Error:', err);
    if (mssql) await mssql.close();
  }
}

restoreData();
