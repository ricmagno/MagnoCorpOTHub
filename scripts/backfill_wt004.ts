import sql from 'mssql';
import fs from 'fs';
import path from 'path';

// Database configuration
const config = {
  user: 'historian',
  password: '8&(@Zb7RETf2fw8O21*!Ok^1@%GaI2jy',
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
const targetTagName = 'BR.WT004.PV'; // Assumed from file header
const startTime = new Date('2026-05-09T04:00:00+10:00');

function fromOADate(oaDate: number): Date {
  const date = new Date(Math.round((oaDate - 25569) * 86400 * 1000));
  return date;
}

async function backfill() {
  console.log('Reading file...');
  const buffer = fs.readFileSync(filePath);
  // Citect exports are often UTF-16LE
  const content = buffer.toString('utf16le');
  const lines = content.split('\n');

  console.log(`Total lines: ${lines.length}`);

  const dataPoints: { timestamp: Date, value: number }[] = [];

  // Skip header (line 0)
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

  console.log(`Filtered data points after ${startTime.toISOString()}: ${dataPoints.length}`);

  if (dataPoints.length === 0) {
    console.log('No data points to backfill.');
    return;
  }

  try {
    console.log('Connecting to Historian...');
    const pool = await sql.connect(config);
    console.log('Connected!');

    const batchSize = 100;
    for (let i = 0; i < dataPoints.length; i += batchSize) {
      const batch = dataPoints.slice(i, i + batchSize);
      console.log(`Inserting batch ${i / batchSize + 1}/${Math.ceil(dataPoints.length / batchSize)}...`);

      const request = new sql.Request(pool);
      
      // Build a multi-insert query
      let query = 'INSERT INTO History (TagName, DateTime, Value, Quality, wwRetrievalMode) VALUES ';
      batch.forEach((dp, index) => {
        // Format date for SQL: YYYY-MM-DD HH:mm:ss.fff
        const dt = dp.timestamp.toISOString().replace('T', ' ').replace('Z', '');
        query += `('${targetTagName}', '${dt}', ${dp.value}, 192, 'Cyclic')${index === batch.length - 1 ? ';' : ','}`;
      });

      await request.query(query);
    }

    console.log('Backfill completed successfully!');
    await sql.close();
  } catch (err) {
    console.error('Error during backfill:', err);
    process.exit(1);
  }
}

backfill();
