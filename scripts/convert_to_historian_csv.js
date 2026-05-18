const fs = require('fs');
const path = require('path');

const inputPath = path.join(__dirname, '../Beetroot_missing_data/Kagome_AU.BR_WT004_PV.xls');
const outputPath = path.join(__dirname, '../Beetroot_missing_data/Kagome_AU.BR_WT004_PV.csv');
const targetTagName = 'Kagome_AU.BR_WT004_PV';
const startTime = new Date('2026-05-09T04:00:00Z'); // Using Z to match our fromOADate logic

function fromOADate(oaDate) {
  const base = new Date('1899-12-30T00:00:00Z').getTime();
  return new Date(base + oaDate * 86400 * 1000);
}

function formatDatePart(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

function formatTimePart(date) {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${h}:${min}:${s}.${ms}`;
}

async function convert() {
  console.log('Reading input file...');
  if (!fs.existsSync(inputPath)) {
    console.error('Input file not found:', inputPath);
    return;
  }
  const buffer = fs.readFileSync(inputPath);
  
  // Remove BOM if present
  let content;
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    content = buffer.slice(2).toString('utf16le');
  } else {
    content = buffer.toString('utf16le');
  }
  
  const lines = content.split('\n');
  console.log(`Processing ${lines.length} lines...`);

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
      const formattedDate = formatDatePart(timestamp);
      const formattedTime = formatTimePart(timestamp);
      
      dataPoints.push({
        timestamp: timestamp.getTime(),
        line: `${targetTagName}|0|${formattedDate}|${formattedTime}|0|${value}|192`
      });
    }
  }

  // Sort chronologically
  dataPoints.sort((a, b) => a.timestamp - b.timestamp);

  const outputLines = [];
  outputLines.push('ASCII');
  outputLines.push('|');
  outputLines.push('0|0|FASTLOAD|1|0');
  
  dataPoints.forEach(dp => outputLines.push(dp.line));

  console.log(`Writing ${dataPoints.length} data points to CSV...`);
  // Explicitly write as 'ascii' to avoid any UTF-8 artifacts
  fs.writeFileSync(outputPath, outputLines.join('\r\n') + '\r\n', 'ascii');
  console.log('Conversion completed successfully!');
  console.log('Output file:', outputPath);
}

convert();
