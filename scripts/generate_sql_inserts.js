const fs = require('fs');

const filePath = '/Users/ricmagno/Documents/Projects/KagomeReports/BeetrootData/BR_WQ001_PV 3.csv';
const outputFilePath = '/Users/ricmagno/Documents/Projects/KagomeReports/restore_wq001_3.sql';
const targetTagName = 'Kagome_AU.BR_WQ001_PV';

console.log('--- Generating SQL File ---');

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

const startRange = new Date('2000-01-01T00:00:00.000+10:00');
const endRange = new Date('2030-01-01T00:00:00.000+10:00');

let sqlContent = '';
let count = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const parts = line.split(',');
  if (parts.length < 3) continue;

  const datePart = parts[0];
  const timePart = parts[1];
  let valueStr = parts[2].replace('\r', '');

  const dateSplit = datePart.split('/');
  if (dateSplit.length !== 3) continue;

  const day = dateSplit[0].padStart(2, '0');
  const month = dateSplit[1].padStart(2, '0');
  const year = dateSplit[2];

  // Strip milliseconds if any, format to exactly YYYY-MM-DD HH:mm:ss
  let formattedTime = timePart;
  if (formattedTime.includes('.')) {
    formattedTime = formattedTime.split('.')[0];
  }

  const sqlDateTime = `${year}-${month}-${day} ${formattedTime}`;
  
  const checkDate = new Date(`${year}-${month}-${day}T${timePart}+10:00`);
  
  if (checkDate >= startRange && checkDate <= endRange) {
    const value = parseFloat(valueStr);
    if (!isNaN(value)) {
      // User's exact format requirement
      const insertStmt = `INSERT INTO History (TagName, DateTime, Value, OPCQuality)\nVALUES ('${targetTagName}', '${sqlDateTime}', ${value}, 192);\n\n`;
      sqlContent += insertStmt;
      count++;
    }
  }
}

fs.writeFileSync(outputFilePath, sqlContent, 'utf8');
console.log(`Successfully generated ${count} INSERT statements.`);
console.log(`Output saved to: ${outputFilePath}`);
