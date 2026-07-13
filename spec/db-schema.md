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

## 🏭 Historian Database (AVEVA / External)
Accessed via read-only SQL connections.
- **Live Table**: Real-time snapshots.
- **History Table**: Historical time-series data.
