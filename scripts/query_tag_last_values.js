const { getHistorianConnection } = require('../dist/services/historianConnection');

async function queryTag() {
  const historian = getHistorianConnection();
  const tagName = 'Kagome_AU.BR_WQ001_PV';
  
  console.log(`Querying last 5 values for: ${tagName}`);
  
  try {
    const query = `
      SELECT TOP 5 TagName, DateTime, Value, Quality
      FROM History
      WHERE TagName = '${tagName}'
      ORDER BY DateTime DESC
    `;
    
    const result = await historian.executeQuery(query);
    console.log(JSON.stringify(result.recordset, null, 2));
    
  } catch (error) {
    console.error('Query failed:', error);
  } finally {
    process.exit();
  }
}

queryTag();
