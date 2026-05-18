import { databaseConfigService } from '../src/services/databaseConfigService';
import { getHistorianConnection, initializeHistorianConnection } from '../src/services/historianConnection';

async function run() {
  console.log('Initializing database config...');
  await databaseConfigService.waitForInitialization();
  
  console.log('Initializing historian connection...');
  const connection = await initializeHistorianConnection();
  
  const query = `
    SELECT TOP 10
      DateTime,
      TagName,
      Value,
      Quality
    FROM History
    WHERE TagName = 'Kagome_AU.BR_WQ001_PV'
      AND DateTime >= '2026-05-11 00:00:00'
      AND DateTime <= '2026-05-18 23:59:59'
      AND wwRetrievalMode = 'Delta'
      AND wwTimeZone = 'UTC'
    ORDER BY DateTime ASC
  `;

  console.log('Executing test query with wwTimeZone = UTC...');
  try {
    const result = await connection.executeQuery(query);
    console.log(`Query returned ${result.recordset.length} rows.`);
    console.log('Sample rows:');
    console.dir(result.recordset.slice(0, 10), { depth: null });
  } catch (error) {
    console.error('Query failed:', error);
  }

  const queryLocal = `
    SELECT TOP 10
      DateTime,
      TagName,
      Value,
      Quality
    FROM History
    WHERE TagName = 'Kagome_AU.BR_WQ001_PV'
      AND DateTime >= '2026-05-11 00:00:00'
      AND DateTime <= '2026-05-18 23:59:59'
      AND wwRetrievalMode = 'Delta'
    ORDER BY DateTime ASC
  `;

  console.log('\nExecuting test query WITHOUT wwTimeZone = UTC (Local Timezone)...');
  try {
    const resultLocal = await connection.executeQuery(queryLocal);
    console.log(`Local query returned ${resultLocal.recordset.length} rows.`);
    console.log('Sample local rows:');
    console.dir(resultLocal.recordset.slice(0, 10), { depth: null });
  } catch (error) {
    console.error('Local query failed:', error);
  }
  
  process.exit(0);
}

run().catch(console.error);
