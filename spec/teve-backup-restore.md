# TEVE Data Backup & Restore Guide

TEVE (Tensor Embedding Vector Engine) stores time-series metrics in PostgreSQL. This guide covers:
- **Automated backups** (recommended for production)
- **Manual backups** (on-demand, for testing or compliance)
- **Data export** (for analysis, migration, or archival)
- **Restore procedures** (disaster recovery)

---

## Overview: Backup Strategy

| Method | Frequency | Best For | Storage | Effort |
|--------|-----------|----------|---------|--------|
| **Automated CronJob** | Daily (configurable) | Production environments | MinIO/S3 (off-site) | Set-and-forget |
| **Manual pg_dump** | On-demand | Testing, compliance audits, pre-release | Local disk or MinIO | ~5 minutes |
| **API Export** | On-demand | Analysis, migration, archival | JSON/CSV download | ~1-5 minutes |
| **Kubernetes PVC snapshot** | Manual | Infrastructure backup | Cloud provider snapshot | Admin-dependent |

**Recommendation:** Use both **automated CronJob** (daily) + **API exports** (weekly manual check). For large datasets, CronJob is faster; for partial recovery or audit, use the export endpoint.

---

## 1. Automated Backups (Kubernetes)

### Setup

The automated backup system requires:
1. **MinIO service** running (for backup storage)
2. **CronJob manifest** deployed
3. **Secret** with MinIO credentials

#### Prerequisites

Ensure `historian-env` secret has `MINIO_SECRET_KEY`:

```bash
kubectl get secret historian-env -n magnocorp-othub -o yaml | grep MINIO_SECRET_KEY
```

If missing, add it:

```bash
kubectl patch secret historian-env -n magnocorp-othub \
  --type merge -p '{"data":{"MINIO_SECRET_KEY":"'$(echo -n 'minioadmin' | base64)'"}}'
```

#### Deploy the backup jobs

```bash
kubectl apply -f Kubernetes/historian-backup-cronjob.yaml
```

This creates two CronJobs:
- **`historian-postgres-backup`** — runs daily at 02:00 UTC, creates gzipped SQL dump
- **`historian-backup-retention`** — runs at 02:30 UTC, deletes backups older than 30 days

#### Verify setup

```bash
# Check CronJobs are scheduled
kubectl get cronjobs -n magnocorp-othub | grep historian-backup

# Check recent backup jobs
kubectl get jobs -n magnocorp-othub | grep historian-postgres-backup

# View backup job logs
kubectl logs -n magnocorp-othub job/historian-postgres-backup-1720310400 -f

# List backups in MinIO
kubectl exec -n magnocorp-othub pod/historian-minio-xxxxx -- \
  mc ls minio/historian-backups/
```

### Customization

Edit `Kubernetes/historian-backup-cronjob.yaml` to adjust:

- **Backup time**: Change `schedule: "0 2 * * *"` (cron format)
  - `"0 2 * * *"` = 2 AM UTC daily
  - `"0 */6 * * *"` = every 6 hours
  - [Cron Expression Generator](https://crontab.guru)

- **Retention policy**: Change `RETENTION_DAYS=30` to keep more/fewer backups

- **Compression level**: Change `--compress=9` (1=fast, 9=best; default 9)

---

## 2. Manual Backup (pg_dump)

### Backup

Connect to Postgres and dump the database:

#### Option A: From the Kubernetes pod

```bash
# Get the Postgres pod name
POD=$(kubectl get pods -n magnocorp-othub -l app=historian-postgres -o jsonpath='{.items[0].metadata.name}')

# Dump the database
kubectl exec -n magnocorp-othub $POD -- pg_dump -U historian -d historian_db \
  --format=plain --compress=9 --no-privileges --no-owner \
  > historian-backup-$(date +%Y%m%d-%H%M%S).sql.gz
```

#### Option B: From your machine (requires port-forward)

```bash
# Forward Postgres port
kubectl port-forward -n magnocorp-othub svc/historian-postgres 5432:5432 &

# Export PGPASSWORD (from the secret)
export PGPASSWORD=$(kubectl get secret -n magnocorp-othub historian-env -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)

# Dump the database
pg_dump -h localhost -U historian -d historian_db \
  --format=plain --compress=9 --no-privileges --no-owner \
  > historian-backup-$(date +%Y%m%d-%H%M%S).sql.gz

# Kill the port-forward
pkill -f "kubectl port-forward"
```

### Verify backup integrity

```bash
# Check file size (should be >1 KB)
ls -lh historian-backup-*.sql.gz

# Test decompression (without extracting)
gzip -t historian-backup-*.sql.gz && echo "Backup is valid"

# Count the number of SQL statements
zcat historian-backup-*.sql.gz | grep -c "INSERT INTO" 
```

---

## 3. Data Export (API)

Export metrics via the TEVE export endpoint for analysis, migration, or archival.

### Export all metrics (JSONL format)

```bash
# Download all metrics as newline-delimited JSON
curl -s http://localhost:3100/api/teve/export?format=jsonl \
  -H "Authorization: Bearer $TOKEN" \
  > teve-export.jsonl

# Each line is one metric:
# {"scada_system_id":"opcua-plc1","tag_name":"Temp001","time":"2026-07-17T15:32:45.123Z","tag_value":23.5,"tag_status":"Good","tag_unit":"degC"}
# {"scada_system_id":"opcua-plc1","tag_name":"Temp001","time":"2026-07-17T15:33:45.123Z","tag_value":23.6,"tag_status":"Good","tag_unit":"degC"}
```

### Export with date range (CSV format)

```bash
# Export only the last 7 days as CSV
FROM=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

curl -s "http://localhost:3100/api/teve/export?format=csv&from=$FROM&to=$TO" \
  -H "Authorization: Bearer $TOKEN" \
  > teve-export-7days.csv
```

### Query parameters

| Parameter | Format | Example | Required? |
|-----------|--------|---------|-----------|
| `format` | `jsonl` or `csv` | `format=csv` | No (default: jsonl) |
| `from` | ISO 8601 | `from=2026-07-10T00:00:00Z` | No |
| `to` | ISO 8601 | `to=2026-07-17T23:59:59Z` | No |

### Use cases

**Analysis in Python:**

```python
import pandas as pd

# Read JSONL export
df = pd.read_json('teve-export.jsonl', lines=True)
df['time'] = pd.to_datetime(df['time'])

# Filter by tag and date
df_temp = df[df['tag_name'] == 'Temp001'].sort_values('time')
print(df_temp[['time', 'tag_value', 'tag_status']])
```

**Upload to S3 for archival:**

```bash
aws s3 cp teve-export-7days.csv s3://my-archive-bucket/teve-backups/
```

**Import into Excel:**

```bash
# Download CSV export and open in Excel
curl -s "http://localhost:3100/api/teve/export?format=csv" \
  > teve-export.csv && open teve-export.csv
```

---

## 4. Restore Procedures

### Scenario A: Full database restore from pg_dump

Use this when the entire Postgres instance is corrupted or lost.

#### Step 1: Stop TEVE services

```bash
# Scale down the historian API and worker pods
kubectl scale deployment -n magnocorp-othub historian-api --replicas=0
kubectl scale deployment -n magnocorp-othub historian-worker --replicas=0

# Verify they are stopped
kubectl get pods -n magnocorp-othub | grep historian
```

#### Step 2: Restore from backup

**Option A: Direct restore to Postgres pod**

```bash
# Get the backup file
BACKUP_FILE="historian-backup-20260717-020000.sql.gz"

# Copy backup into the pod
kubectl cp $BACKUP_FILE magnocorp-othub/$POD:/tmp/$BACKUP_FILE

# Restore (this will drop and recreate the database)
kubectl exec -n magnocorp-othub $POD -- \
  bash -c "
    export PGPASSWORD=\$(cat /run/secrets/historian-env/POSTGRES_PASSWORD)
    dropdb -U historian -h localhost historian_db --if-exists
    createdb -U historian -h localhost historian_db
    zcat /tmp/$BACKUP_FILE | psql -U historian -h localhost -d historian_db
    rm /tmp/$BACKUP_FILE
  "
```

**Option B: Restore to a new database (non-destructive testing)**

```bash
# Create a test database
kubectl exec -n magnocorp-othub $POD -- \
  bash -c "
    export PGPASSWORD=\$(cat /run/secrets/historian-env/POSTGRES_PASSWORD)
    createdb -U historian -h localhost historian_db_test
    zcat /tmp/$BACKUP_FILE | psql -U historian -h localhost -d historian_db_test
  "

# Query the test database to verify
kubectl exec -n magnocorp-othub $POD -- \
  bash -c "
    export PGPASSWORD=\$(cat /run/secrets/historian-env/POSTGRES_PASSWORD)
    psql -U historian -h localhost -d historian_db_test -c 'SELECT COUNT(*) FROM historian.metrics;'
  "

# If successful, swap databases
kubectl exec -n magnocorp-othub $POD -- \
  bash -c "
    export PGPASSWORD=\$(cat /run/secrets/historian-env/POSTGRES_PASSWORD)
    dropdb -U historian -h localhost historian_db
    psql -U historian -h localhost -c 'ALTER DATABASE historian_db_test RENAME TO historian_db;'
  "
```

#### Step 3: Restart services

```bash
# Scale pods back up
kubectl scale deployment -n magnocorp-othub historian-api --replicas=1
kubectl scale deployment -n magnocorp-othub historian-worker --replicas=1

# Verify they are running
kubectl get pods -n magnocorp-othub | grep historian
```

#### Step 4: Verify data

```bash
# Check that data is present
curl http://localhost:3100/api/teve/tags | jq '.count'

# Spot-check a tag's data
curl "http://localhost:3100/api/teve/data?tag=opcua-plc1.Temp001&from=2026-07-01T00:00:00Z&to=2026-07-18T00:00:00Z" | jq '.count'
```

### Scenario B: Partial restore (single tag or date range)

Use this to recover a specific tag's data without affecting the entire database.

#### From backup file

```bash
# Extract only the INSERT statements for a specific tag
zcat historian-backup-20260717-020000.sql.gz | \
  grep "INSERT INTO historian.metrics.*tag_name='Temp001'" > temp001-recovery.sql

# Review the SQL
head temp001-recovery.sql

# Apply to the database
psql -U historian -h localhost -d historian_db < temp001-recovery.sql
```

#### From API export

```bash
# Export the tag's data
FROM=$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s "http://localhost:3100/api/teve/export?format=csv&from=$FROM" | \
  grep "opcua-plc1,Temp001" > temp001-recovery.csv

# This creates a CSV that can be:
# 1. Analyzed in Excel/Python
# 2. Imported into another TEVE instance
# 3. Archived for compliance
```

### Scenario C: Migrate data to another TEVE instance

Use this to move data between TEVE deployments (e.g., staging → production).

#### Step 1: Export from source

```bash
# Export all data from source TEVE
curl -s "http://source-teve:3100/api/teve/export?format=jsonl" \
  > teve-migration-full.jsonl

# Verify export
wc -l teve-migration-full.jsonl
head teve-migration-full.jsonl
```

#### Step 2: Transform if needed (optional)

```bash
# Example: update scada_system_id if migrating between clusters
sed 's/"scada_system_id":"opcua-plc1"/"scada_system_id":"opcua-plc2"/g' \
  teve-migration-full.jsonl > teve-migration-transformed.jsonl
```

#### Step 3: Import to target

```bash
# Convert JSONL back to ingest format and push to target TEVE
python3 << 'EOF'
import json
import requests

target_url = "http://target-teve:3100/api/teve/ingest"
headers = {"Content-Type": "application/json"}
batch_size = 1000
batch = []

with open('teve-migration-full.jsonl', 'r') as f:
    for i, line in enumerate(f):
        metric = json.loads(line)
        batch.append({
            'time': metric['time'],
            'tagName': metric['tag_name'],
            'value': metric['tag_value'],
            'status': metric['tag_status'],
            'unit': metric['tag_unit']
        })
        
        if len(batch) == batch_size:
            payload = {
                'scadaSystem': {'id': metric['scada_system_id'], 'name': metric['scada_system_id']},
                'metrics': batch
            }
            r = requests.post(target_url, json=payload, headers=headers)
            print(f"Batch {i//batch_size}: {r.status_code}")
            batch = []

if batch:
    payload = {
        'scadaSystem': {'id': batch[0]['tagName'].split('.')[0], 'name': 'migrated'},
        'metrics': batch
    }
    requests.post(target_url, json=payload, headers=headers)
EOF
```

---

## 5. Backup Testing & Validation

### Test the automated backup

```bash
# Trigger an on-demand backup job (for testing)
kubectl create job historian-postgres-backup-test \
  -n magnocorp-othub \
  --from=cronjob/historian-postgres-backup

# Watch the job
kubectl logs -n magnocorp-othub -f job/historian-postgres-backup-test

# Verify the backup was uploaded to MinIO
kubectl exec -n magnocorp-othub svc/historian-minio -- \
  mc ls minio/historian-backups/ --recursive
```

### Test restore from backup

```bash
# Restore to a test database (non-destructive)
# Follow "Step 2: Option B" from Scenario A above

# Verify row count matches
kubectl exec -n magnocorp-othub $POD -- \
  bash -c "
    export PGPASSWORD=\$(psql -U historian -h localhost -d historian_db -c 'SELECT COUNT(*) FROM historian.metrics;')
    echo 'Original DB rows: '$PGPASSWORD
    
    export PGPASSWORD=\$(psql -U historian -h localhost -d historian_db_test -c 'SELECT COUNT(*) FROM historian.metrics;')
    echo 'Restored DB rows: '$PGPASSWORD
  "
```

### Document your backup procedure

Create a runbook in your operations wiki:

```
# TEVE Backup Runbook

## Daily automated backups
- Status: ✅ Running daily at 02:00 UTC
- Location: MinIO bucket `historian-backups`
- Retention: 30 days
- Last backup: [check via kubectl or MinIO console]

## Testing schedule
- Monthly: Restore a test backup to verify integrity
- Quarterly: Full restore drill to production-like environment

## Alert thresholds
- Alert if backup job fails for 3 consecutive days
- Alert if MinIO disk usage exceeds 80%
- Alert if restore test takes >30 minutes
```

---

## 6. Troubleshooting

### Backup job failed

```bash
# Check job logs
kubectl describe job -n magnocorp-othub historian-postgres-backup-20260717-020000

# View pod logs
kubectl logs -n magnocorp-othub historian-postgres-backup-20260717-020000-xxxxx

# Common issues:
# - "Connection refused" → Postgres not running (check historian-postgres pod)
# - "Access Denied" → MinIO credentials wrong (check historian-env secret)
# - "Disk full" → MinIO volume is full (increase PVC size)
```

### Cannot connect to Postgres during restore

```bash
# Check if Postgres pod is running
kubectl get pods -n magnocorp-othub -l app=historian-postgres

# Check Postgres logs
kubectl logs -n magnocorp-othub historian-postgres-xxxxx

# Verify password
kubectl get secret -n magnocorp-othub historian-env -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

### Backup file is corrupted

```bash
# Test the gzip file
gzip -t backup-file.sql.gz

# If corrupted:
# 1. Download a different backup from MinIO
# 2. Check if restore from backup succeeds
# 3. Report the issue to ops team
```

---

## 7. Compliance & Audit Trail

For compliance (SOC 2, ISO 27001, etc.):

### Backup frequency proof

```bash
# List all backups created in the last month
kubectl exec -n magnocorp-othub svc/historian-minio -- \
  mc find minio/historian-backups/ --newer-than 30d
```

### Restore test log

```bash
# Document every restore test
echo "2026-07-18 10:30 UTC - Restore test initiated by ops-team" >> backups/restore-tests.log
echo "2026-07-18 10:35 UTC - Restore successful, 5.2M metrics verified" >> backups/restore-tests.log
```

### Export for audit

```bash
# Export and retain for audit retention period (typically 7 years)
curl -s "http://localhost:3100/api/teve/export?format=csv" \
  > teve-export-audit-2026-Q3.csv

# Sign the file with GPG (optional)
gpg --armor --detach-sign teve-export-audit-2026-Q3.csv
```

---

## 8. Summary: What You Need to Do

### Before going to production

- [ ] Deploy `historian-backup-cronjob.yaml` to your K8s cluster
- [ ] Verify the backup job ran successfully (check MinIO)
- [ ] Test a restore from the backup
- [ ] Document your backup schedule and contact (ops runbook)
- [ ] Set up monitoring alerts for backup failures

### Operational tasks

- [ ] Monthly: Run a restore test to a non-production database
- [ ] Quarterly: Full restore drill including service restart
- [ ] Yearly: Audit backup retention and compliance with data retention laws

### Emergency recovery (if needed)

- [ ] Use this guide's Scenario A to restore from backup
- [ ] Or use Scenario B/C for partial recovery or migration
- [ ] Test connectivity to TEVE after restore
