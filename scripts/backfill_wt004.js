const fs = require('fs');
const path = require('path');

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
  requestTimeout: 60000
};

const filePath = path.join(__dirname, '../Beetroot_missing_data/BR_WT004_PV.xls');
const targetTagName = 'Kagome_AU.BR_WT004_PV';
const startTime = new Date('2026-05-09T04:00:00+10:00');

function fromOADate(oaDate) {
  return new Date(Math.round((oaDate - 25569) * 86400 * 1000));
}

async function backfill() {
  process.stdout.write('--- Start Backfill ---\n');
  process.stdout.write('Reading file: ' + filePath + '\n');
  if (!fs.existsSync(filePath)) {
    console.error('File not found!');
    return;
  }
  const buffer = fs.readFileSync(filePath);
  console.log('File read, size:', buffer.length);
  
  // Remove BOM if present (FF FE for UTF-16LE)
  let content;
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    console.log('Found UTF-16LE BOM, stripping...');
    content = buffer.slice(2).toString('utf16le');
  } else {
    content = buffer.toString('utf16le');
  }
  
  const lines = content.split('\n');
  console.log(`Total lines split: ${lines.length}`);

  const dataPoints = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const oaDate = parseFloat(parts[0]);
    const valueStr = parts[2];

    if (isNaN(oaDate)) continue;
    if (valueStr.toLowerCase() === 'n/a') continue;

    const value = parseFloat(valueStr);
    if (isNaN(value)) continue;

    const timestamp = fromOADate(oaDate);
    if (timestamp >= startTime) {
      dataPoints.push({ timestamp, value });
    }
  }

  console.log(`Filtered data points: ${dataPoints.length}`);

  if (dataPoints.length === 0) return;

  try {
    process.stdout.write('Connecting to Historian...\n');
    const sql = require('mssql');
    const pool = await sql.connect(config);
    console.log('Connected!');

    const batchSize = 50; // Smaller batch size due to slow connection
    for (let i = 0; i < dataPoints.length; i += batchSize) {
      const batch = dataPoints.slice(i, i + batchSize);
      console.log(`Inserting batch ${i / batchSize + 1}/${Math.ceil(dataPoints.length / batchSize)}...`);

      const request = new sql.Request(pool);
      let query = 'INSERT INTO History (TagName, DateTime, Value, Quality, wwRetrievalMode) VALUES ';
      batch.forEach((dp, index) => {
        const dt = dp.timestamp.toISOString().replace('T', ' ').replace('Z', '');
        query += `('${targetTagName}', '${dt}', ${dp.value}, 192, 'Cyclic')${index === batch.length - 1 ? ';' : ','}`;
      });

      await request.query(query);
    }

    console.log('Backfill completed!');
    await sql.close();
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

backfill();
