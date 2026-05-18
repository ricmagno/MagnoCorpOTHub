const fs = require('fs');
const mssql = require('mssql');

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
  requestTimeout: 300000
};

const sqlFilePath = process.argv[2];

async function run() {
  if (!sqlFilePath) {
    console.error('Please provide a SQL file path');
    return;
  }
  
  if (!fs.existsSync(sqlFilePath)) {
    console.error(`File not found: ${sqlFilePath}`);
    return;
  }

  const content = fs.readFileSync(sqlFilePath, 'utf8');
  // Split by semicolon and filter out empty strings
  const statements = content.split(';').map(s => s.trim()).filter(s => s.length > 0);

  console.log(`Found ${statements.length} statements in ${sqlFilePath}`);

  try {
    console.log('Connecting to Historian...');
    const pool = await mssql.connect(config);
    console.log('Connected!');

    let count = 0;
    // We can execute them in batches or sequentially.
    // For 150-10000 statements, sequential execution is safe but maybe slightly slow.
    // Let's do it sequentially to ensure any error points to the exact statement.
    for (const stmt of statements) {
      await pool.request().query(stmt);
      count++;
      if (count % 50 === 0) {
        console.log(`Executed ${count}/${statements.length} statements...`);
      }
    }
    
    console.log(`--- Successfully executed all ${count} statements! ---`);
    await mssql.close();
  } catch (err) {
    console.error('Database Error:', err);
    if (mssql) await mssql.close();
  }
}

run();
