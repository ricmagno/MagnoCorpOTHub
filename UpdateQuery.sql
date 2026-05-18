-- UpdateQuery.sql
-- This query updates values resulting from a SELECT query by inserting them back
-- into the History table. AVEVA Historian uses INSERT INTO to update existing records.

INSERT INTO History (TagName, DateTime, Value, Quality)
SELECT
    TagName,
    DateTime,
    Value * 1.5,     -- Example: Update the value (e.g., multiply by 1.5)
    192              -- Explicitly setting Quality to Good (192)
FROM History
WHERE TagName = 'Kagome_AU.BR_WQ001_PV'
  AND DateTime >= '2026-02-01 00:00:00'
  AND DateTime <= '2026-02-21 00:00:00'
  AND wwRetrievalMode = 'Delta';
