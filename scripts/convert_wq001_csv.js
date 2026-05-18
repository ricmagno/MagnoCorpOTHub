const fs = require('fs');
const path = require('path');

const inputPath = path.join(__dirname, '../Beetroot_missing_data/BR_WQ001_PV.csv');
const outputPath = path.join(__dirname, '../Beetroot_missing_data/Kagome_AU.WQ001_PV.csv');
const targetTagName = 'Kagome_AU.WQ001_PV';

async function convert() {
  console.log('Reading input file:', inputPath);
  const content = fs.readFileSync(inputPath, 'utf8');
  const lines = content.split('\n');
  console.log(`Processing ${lines.length} lines...`);

  const dataPoints = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 3) continue;

    const datePart = parts[0]; // e.g., 6/05/2026
    const timePart = parts[1]; // e.g., 15:34:00.000
    const value = parts[2];

    // Convert D/MM/YYYY to YYYY/MM/DD
    const dateParts = datePart.split('/');
    if (dateParts.length !== 3) continue;
    
    const day = dateParts[0].padStart(2, '0');
    const month = dateParts[1].padStart(2, '0');
    const year = dateParts[2];
    
    const formattedDate = `${year}/${month}/${day}`;
    // Ensure time part has milliseconds
    const formattedTime = timePart.includes('.') ? timePart : `${timePart}.000`;

    // Create a sortable timestamp
    const sortableTimestamp = `${year}-${month}-${day}T${timePart.split('.')[0]}`;

    dataPoints.push({
      timestamp: sortableTimestamp,
      line: `${targetTagName}|0|${formattedDate}|${formattedTime}|0|${value}|192`
    });
  }

  // Sort chronologically
  dataPoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

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
