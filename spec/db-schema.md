# Database Schema Specification

This document defines the authoritative schema for the application's configuration and metadata databases.

## 🗄️ Configuration Database (SQLite/scheduler.db)

### `users`
Stores system users and their roles.
- `id`: Primary Key.
- `username`: Unique.
- `passwordHash`: Bcrypt hash.
- `role`: (admin, user).

### `schedules`
Stores automated report triggers.
- `id`: Primary Key.
- `name`: Title of the schedule.
- `cron`: Cron expression.
- `reportConfig`: JSON blob containing report parameters.

### `configurations`
Stores global application settings.
- `key`: Unique setting name (e.g., `SMTP_HOST`).
- `value`: Setting value.

### `site_settings` (in `auth.db`)
Stores branding and white-label settings. Managed by `brandingService.ts`.
- `key`: Setting name. Known keys: `companyName`, `appName`, `siteName`, `primaryColor`, `accentColor`, `website`, `reportFooter`, `emailSenderName`, `logo` (base64 data URL).
- `value`: Setting value.
- `updated_at`: Last modification timestamp.

### `alert_configs` (in `alerts.db`)
Alarm-monitoring configs evaluated by `alertEvalService.ts` over OPC UA subscriptions.
- `tag_base`: Bare OPC UA node-id base (no `opcua:` prefix, no connection qualifier).
- `connection_id`: OPC UA connection the nodes live on. NULL = unqualified legacy row — only evaluated when an admin has designated a legacy-default connection.
- (plus name/description, monitor_hh/h/l/ll, alert_list_id, pattern_id, is_active, audit columns.)

### `teve_historize_tags_v2` (in `auth.db`)
Admin-selected OPC UA tags continuously historized into TEVE (`teveIngestService.ts`).
- Primary key `(connection_id, node_id)` — the same nodeId may exist on multiple PLCs.
- `connection_id`: `''` (empty string) = unqualified legacy row, same fallback rule as above.
- v1 table `teve_historize_tags` (PK `node_id`) is copied over and dropped on first open.

## 🔌 OPC UA Connections (`opcua-configs.json`, v2)
Managed by `opcuaConfigService.ts` (not SQLite). Shape:
- `version`: 2.
- `legacyDefaultConnectionId`: connection that unqualified `opcua:<nodeId>` tags resolve to; **null by default** (fallback disabled; explicit admin opt-in).
- `configurations[]`: `id`, `name`, `alias` (unique slug used in qualified tags), `endpointUrl`, security/auth fields, `encryptedPassword`, `enabled` (many may be true), `collectorId` (reserved, Phase 2 edge collector).
- v1 files (single `activeConfigId`) migrate automatically on load: `enabled` ← `isActive`, aliases generated from names, `legacyDefaultConnectionId` stays null.

## 🏭 Historian Database (AVEVA / External)
Accessed via read-only SQL connections.
- **Live Table**: Real-time snapshots.
- **History Table**: Historical time-series data.
