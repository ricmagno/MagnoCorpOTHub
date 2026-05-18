const fs = require('fs');
const path = require('path');
const mssql = require('mssql');

const config = {
  user: 'historian',
  password: '8&(@Zb7RETf2fw8O21*!Ok^1@%GaI2jy',
  server: '192.168.235.17',
  database: 'Runtime',
  options: {
    encrypt: false, // Set to false as per existing script
    trustServerCertificate: true,
    enableArithAbort: true
  },
  connectionTimeout: 60000,
  requestTimeout: 120000 // Increased timeout for large batches
};

const filePath = '/Users/ricmagno/Documents/Projects/KagomeReports/Beetroot_missing_data/Kagome_AU.WQ001_PV.csv';
const targetTagName = 'Kagome_AU.BR_WQ001_PV'; // Fixed tag name
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : Infinity;

async function backfill() {
  console.log('--- Start Backfill via SQL INSERT ---');
  if (LIMIT !== Infinity) console.log(`DRY RUN: Limiting to ${LIMIT} points.`);
  console.log('Target Tag:', targetTagName);
  console.log('Reading file:', filePath);
  
  if (!fs.existsSync(filePath)) {
    console.error('File not found!');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  console.log(`Total lines read: ${lines.length}`);

  const dataPoints = [];
  
  // Date formats supported:
  // 1. DD/MM/YYYY HH:MM:SS (Standard CSV)
  // 2. YYYY/MM/DD and HH:MM:SS (Fast Load format)
  const dateRegexStandard = /(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/;
  const dateRegexFastLoad = /(\d{4})\/(\d{2})\/(\d{2})/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line === 'ASCII' || line === '|' || line.includes('FASTLOAD')) continue;

    // Detect delimiter
    const delimiter = line.includes('|') ? '|' : ',';
    const parts = line.split(delimiter);
    
    let sqlDateTime, value;

    if (delimiter === ',') {
      // Standard CSV: TagName, DateTime, Value, Quality
      if (parts.length < 3) continue;
      const dateTimeStr = parts[1].trim();
      const valueStr = parts[2].trim();
      
      const match = dateTimeStr.match(dateRegexStandard);
      if (match) {
        sqlDateTime = `${match[3]}-${match[2]}-${match[1]} ${match[4]}:${match[5]}:${match[6]}`;
      }
      value = parseFloat(valueStr);
    } else {
      // Fast Load format: TagName|Op|Date|Time|ValueType|Value|Quality
      // Example: Kagome_AU.WQ001_PV|0|2026/05/06|15:34:00.000|0|91816|192
      if (parts.length < 6) continue;
      const datePart = parts[2].trim();
      const timePart = parts[3].trim().split('.')[0]; // Remove milliseconds
      const valueStr = parts[5].trim();
      
      const match = datePart.match(dateRegexFastLoad);
      if (match) {
        sqlDateTime = `${match[1]}-${match[2]}-${match[3]} ${timePart}`;
      }
      value = parseFloat(valueStr);
    }

    if (!sqlDateTime) {
      console.warn(`Line ${i+1}: Could not parse date from line: ${line}`);
      continue;
    }

    if (isNaN(value)) {
      console.warn(`Line ${i+1}: Invalid value in line: ${line}`);
      continue;
    }

    dataPoints.push({ timestamp: sqlDateTime, value });
    
    if (dataPoints.length >= LIMIT) break;
  }

  console.log(`Parsed data points: ${dataPoints.length}`);

  if (dataPoints.length === 0) {
    console.log('No data points to insert.');
    return;
  }

  try {
    console.log('Connecting to Historian at', config.server);
    const pool = await mssql.connect(config);
    console.log('Connected!');

    const batchSize = 100; 
    for (let i = 0; i < dataPoints.length; i += batchSize) {
      const batch = dataPoints.slice(i, i + batchSize);
      console.log(`Inserting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(dataPoints.length / batchSize)} (${batch.length} points)...`);

      const request = new mssql.Request(pool);
      // Basic INSERT syntax verified to work: INSERT INTO History (TagName, DateTime, Value) VALUES ('tag', 'date', val)
      let query = 'INSERT INTO History (TagName, DateTime, Value) VALUES ';
      
      batch.forEach((dp, index) => {
        query += `('${targetTagName}', '${dp.timestamp}', ${dp.value})${index === batch.length - 1 ? ';' : ','}`;
      });

      await request.query(query);
    }

    console.log('--- Backfill completed successfully! ---');
    await mssql.close();
  } catch (err) {
    console.error('Database Error:', err);
    process.exit(1);
  }
}

backfill();
