# TEVE Dashboard Guide

The TEVE Dashboard is a web-based admin interface for monitoring and managing the Tensor Embedding Vector Engine. It provides:

- **Real-time configuration display** — current settings for database, embedding model, storage, worker
- **Service health & statistics** — uptime, metric count, data freshness, active tags
- **Operations** — cache management, quick actions
- **Secure access** — bearer token authentication

## Accessing the Dashboard

### Local Development

```bash
# The admin/export endpoints fail closed — set a token before starting, or they
# return HTTP 503 ("disabled: HISTORIAN_ADMIN_TOKEN is not configured").
export HISTORIAN_ADMIN_TOKEN="$(openssl rand -hex 32)"

# Start TEVE historian service (if not already running)
npm run historian:dev

# Open the dashboard
open http://localhost:3100/dashboard
```

You'll be prompted for the admin token — use the value you set in `HISTORIAN_ADMIN_TOKEN`.
There is **no default token**: if the variable is unset, the admin dashboard and the
bulk-data endpoints (`/api/teve/export`, `/api/teve/pointsdata`) are disabled entirely.

### Production (Kubernetes)

```bash
# Port-forward to the historian-api service
kubectl port-forward -n magnocorp-othub svc/historian-api 3100:3100

# Open the dashboard
open https://your-domain.com/dashboard
```

Enter the admin token when prompted.

## Authentication

The dashboard uses bearer token authentication. The token must be provided as:

```
Authorization: Bearer <HISTORIAN_ADMIN_TOKEN>
```

### Setting the Admin Token

In Kubernetes, add the token to the `historian-env` secret:

```bash
# Set a strong token (use a password generator)
kubectl patch secret -n magnocorp-othub historian-env \
  --type merge -p '{"stringData":{"HISTORIAN_ADMIN_TOKEN":"your-secure-token-here"}}'
```

In local development, set the environment variable:

```bash
export HISTORIAN_ADMIN_TOKEN="your-dev-token"
npm run historian:dev
```

**⚠️ Security Note:** The token is transmitted in the `Authorization` header. Always use HTTPS in production to prevent token interception.

## Dashboard Sections

### Service Status
- **Healthy/Degraded** indicator
- Service uptime
- Last update timestamp

### Database
- Connection status (✅ Connected / ❌ Disconnected)
- Database endpoint (password masked)

### Embedding Model
- Model name (e.g., `Xenova/clip-vit-base-patch16`)
- Embedding dimension (512 for CLIP-ViT-Base)
- Remote models allowed (yes/no)

### Storage (S3/MinIO)
- S3 endpoint
- Bucket name
- Region

### Redis Queue
- Redis connection URL (password masked)

### Worker
- Concurrency (number of parallel embedding jobs)
- Health check port

### Database Statistics
- **Total Metrics** — how many time-series data points are stored
- **Unique Tags** — how many distinct tag streams (SCADA system + tag name)
- **Data Present** — whether any metrics have been ingested
- **Latest Update** — when the most recent metric was written

## API Endpoints

The dashboard fetches data from these read-only API endpoints (all require admin token):

### GET /api/admin/config

Returns current TEVE configuration (passwords masked).

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/admin/config
```

Response:
```json
{
  "database": {
    "url": "postgresql://historian:***@historian-postgres:5432/historian_db",
    "isConnected": true
  },
  "s3": {
    "endpoint": "http://historian-minio:9000",
    "bucket": "historian-data",
    "region": "us-east-1"
  },
  "embedding": {
    "model": "Xenova/clip-vit-base-patch16",
    "dimension": 512,
    "allowRemoteModels": false,
    "cacheDir": "./.model-cache"
  },
  "worker": {
    "concurrency": 4,
    "healthPort": 3101
  },
  "teve": {
    "tsWindowMinutes": 60,
    "tsEmbedEveryMinutes": 15
  }
}
```

### GET /api/admin/status

Returns current service health and statistics.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/admin/status
```

Response:
```json
{
  "uptime": 3600,
  "timestamp": "2026-07-19T10:30:45.123Z",
  "database": {
    "metrics_count": 1234567,
    "unique_tags": 42,
    "oldest_metric": "2026-07-01T00:00:00Z",
    "newest_metric": "2026-07-19T10:29:55.321Z"
  },
  "version": "1.3.1",
  "nodeVersion": "v20.15.0"
}
```

### POST /api/admin/clear-cache

Signal the embedding worker to clear its model cache (forces reload on next inference).

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/admin/clear-cache
```

### GET /api/admin/health

Simple liveness check (no authentication required — used by Kubernetes health probes).

```bash
curl http://localhost:3100/api/admin/health
```

## Auto-Refresh

The dashboard automatically refreshes configuration and statistics every 30 seconds. You can also manually refresh using the **🔄 Refresh** button.

## Operations

### Clear Embedding Cache

If the embedding model is consuming excessive memory or needs to be updated:

1. Click **🗑️ Clear Cache**
2. The worker will unload the model from memory
3. On the next inference request, the model will be reloaded (or downloaded if remote models are allowed)

### Check Data Freshness

The **Database Statistics** section shows:
- How much data is stored (total metrics)
- When the data was last updated
- Whether the historize service is actively writing

If **Latest Update** is showing old timestamps, check:
1. Is teveIngestService running? (check main app logs)
2. Are OPC UA tags configured to historize? (`/api/teve-tag-config` in the main app)
3. Is the OPC UA connection active?

### Monitor Memory Usage

The **Embedding Model** section shows if remote models are allowed. If memory is high:
1. Click **Clear Cache** to free the in-memory model (~600MB)
2. Check worker logs for repeated reload attempts (could indicate cache thrashing)

## Security Considerations

### Token Management

- **Change the default token** immediately in production
- Store the token in a secrets manager (not in code)
- Rotate tokens regularly (at least annually)
- Use a strong random token (≥32 characters)

### Network Access

The dashboard is accessible at `https://your-domain.com/dashboard` if it's behind an Ingress with HTTPS. To restrict access further:

1. **Firewall rules** — restrict network access to admin IPs only
2. **NetworkPolicy** — Kubernetes network policies can restrict pod access
3. **Ingress authentication** — add HTTP Basic Auth or OAuth2 proxy in front of the dashboard

### HTTPS Enforcement

Always use HTTPS for the dashboard in production:

```bash
# Check your Ingress
kubectl get ingress -n magnocorp-othub historian-ingress -o yaml | grep -A 5 "tls:"
```

The token must not be transmitted over HTTP.

### Audit Logging

Currently, the dashboard doesn't log access. For compliance:

1. Enable ingress access logs (see Kubernetes documentation)
2. Forward logs to a centralized logging system
3. Set up alerts for repeated failed auth attempts (401 errors)

## Troubleshooting

### "Unauthorized: invalid or missing admin token"

The token you entered doesn't match `HISTORIAN_ADMIN_TOKEN`. 

- **Development:** Check your `.env` or shell environment variable
- **Kubernetes:** Verify the secret:
  ```bash
  kubectl get secret -n magnocorp-othub historian-env -o jsonpath='{.data.HISTORIAN_ADMIN_TOKEN}' | base64 -d
  ```

### Dashboard is loading but showing "Loading..." forever

1. Check browser console for errors (F12 → Console tab)
2. Verify the admin token is correct
3. Check that the historian-api service is running:
   ```bash
   kubectl get pods -n magnocorp-othub | grep historian-api
   ```
4. Check logs:
   ```bash
   kubectl logs -n magnocorp-othub deployment/historian-api
   ```

### Database shows "Disconnected"

This means the historian-api cannot reach the Postgres service:

1. Verify Postgres pod is running:
   ```bash
   kubectl get pods -n magnocorp-othub | grep historian-postgres
   ```
2. Check network connectivity:
   ```bash
   kubectl exec -n magnocorp-othub historian-api-xxxxx -- \
     pg_isready -h historian-postgres -U historian
   ```
3. Check credentials match in `historian-env` secret

### No metrics showing

If **Total Metrics** is 0:

1. Check teveIngestService is running in the main app:
   ```bash
   kubectl logs -n magnocorp-othub deployment/magnocorp-othub | grep "TeveIngestService"
   ```
2. Verify OPC UA tags are configured:
   - Open main app → Configuration → TEVE Tags
   - Are any tags listed? If not, add some via "Browse OPC UA Tags"
3. Check OPC UA connection is working:
   - Configuration → OPC UA Connections
   - Is the connection status "Connected"?

## Future Enhancements

Potential additions to the dashboard:

- **Settings editor** — adjust retention policies, window sizes, embedding frequency
- **Logs viewer** — tail recent service logs
- **Metrics export** — download config as JSON for backup/migration
- **Performance graphs** — memory, CPU, query latency over time
- **User audit trail** — who accessed the dashboard and when
- **Multi-user auth** — replace bearer token with user roles/permissions

---

**Need help?** See [spec/teve-backup-restore.md](teve-backup-restore.md) for backup and disaster recovery procedures, or [spec/deployment.md](deployment.md) for full deployment documentation.
