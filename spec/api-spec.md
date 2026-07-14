# API Specification

This document defines the core API endpoints for the MagnoCorpOTHub backend.

## 🔐 Authentication
- `POST /api/auth/login`: Authenticate user and return JWT.
- `POST /api/auth/logout`: Invalidate session.

## 📊 Data & Reports
- `POST /api/data/query`: Query historical data from Historian.
- `GET /api/reports`: List all report configurations.
- `POST /api/reports/generate`: Trigger manual PDF generation.
- `GET /api/reports/:id/download`: Download a generated PDF.

## ⚙️ Configuration
- `GET /api/configuration`: Fetch global settings.
- `PUT /api/configuration`: Update settings (DB connections, SMTP, etc.).
- `GET /api/database-config`: Manage Historian SQL connections.

### OPC UA (multi-connection, mounted at `/api/opcua`)
Many OPC UA server connections (KEPServerEX, PLCs) may be enabled simultaneously.
Tags use the qualified form `opcua:<alias-or-id>:<nodeId>`. Unqualified legacy tags
(`opcua:<nodeId>`) resolve only when an admin has designated a legacy-default
connection — the fallback is OFF by default.

- `GET /api/opcua/configs`: List configurations with `alias`, `enabled`, `isLegacyDefault`, live `liveStatus`/`lastError` (passwords never returned).
- `POST /api/opcua/configs`: Create/update a configuration (admin). Optional `alias` (2-32 chars `[a-z0-9-]`, unique; generated from name if absent).
- `POST /api/opcua/configs/:id/enable` | `.../disable`: Toggle a connection (admin); enabling starts it, disabling stops it.
- `POST /api/opcua/configs/:id/legacy-default`: Designate the connection that unqualified legacy tags resolve to (admin; explicit opt-in).
- `DELETE /api/opcua/legacy-default`: Clear the legacy-default designation (admin).
- `POST /api/opcua/test-connection`: Test a candidate config on a throwaway connection (never disturbs live connections).
- `GET /api/opcua/browse?nodeId=&connectionId=`: Browse a server's address space. `connectionId` (id or alias) required unless a legacy default is designated.
- `GET /api/opcua/connections`: Runtime status of all live connections.
- `POST /api/opcua/migrate-legacy-tags` `{ connectionId, dryRun? }`: One-shot idempotent rewrite of stored unqualified tags (alert configs, TEVE historize tags, report/dashboard configs) to the qualified form (admin). With `dryRun: true`, nothing is written — returns the counts plus up to 20 sample rewrites for a UI preview.
- `POST /api/opcua/activate/:id`: **Deprecated** alias for enable (one release).
- `DELETE /api/opcua/configs/:id`: Delete a configuration (admin; refused for the legacy-default connection). Referencing alert-config/TEVE rows are unbound (`connection_id` → NULL) and the counts returned as `{ alertConfigsUnbound, teveTagsUnbound }`.

`GET /api/health/services` reports OPC UA as `not_configured` (no enabled configs), `healthy` (all enabled connections have sessions) or `unhealthy`, with per-connection detail under `services.opcua.connections` (`status`, `lastError`, `subscriptionCount`, `monitoredItemCount`, `lastDataTimestamp`, `isLegacyDefault`). While no legacy-default connection is designated, `services.opcua.unresolvedLegacyTagCount` counts stored tag rows that resolve to nothing; the top-level payload includes `memory: { rssMb, heapUsedMb }` for sizing (see spec/deployment.md).

## 🕒 Schedules
- `GET /api/schedules`: List automated report schedules.
- `POST /api/schedules`: Create/Update a schedule.

## 👤 User Management
- `GET /api/users`: List system users (Admin only).
- `POST /api/users`: Manage user roles and permissions.
