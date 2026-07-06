# Database Schema Specification

This document defines the authoritative schema for the application's configuration and metadata databases.

## 🗄️ Configuration Database (SQLite/scheduler.db)

### `users`
Stores system users and their roles.
- `id`: Primary Key.
- `username`: Unique.
- `passwordHash`: Bcrypt hash. For SSO-provisioned users (`auth_provider != 'local'`) this is a hash of unusable random bytes — these accounts never authenticate with a local password.
- `role`: (admin, user).
- `auth_provider` (in `auth.db`'s `users` table): `local` | `ldap` | `oidc`. Defaults to `local`.
- `external_id` (in `auth.db`'s `users` table): stable directory identifier (AD `objectGUID` / OIDC `sub`) for SSO-provisioned users. Unique together with `auth_provider`.
- `external_last_sync` (in `auth.db`'s `users` table): timestamp of the last successful SSO login.

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

### `identity_providers` (in `auth.db`)
Stores per-provider identity/domain-authentication settings. Managed by `identityProviderService.ts`.
- `id`: Primary Key. One row per provider — `ldap` or `oidc`.
- `enabled`: Whether login attempts fall through to this provider. Disabled by default — local username/password auth remains the factory-default authentication method.
- `config`: JSON blob of provider connection settings (LDAP: `url`, `bindDn`, `baseDn`, `userFilter`, `tlsRejectUnauthorized`, `caCert`; OIDC: `issuer`, `clientId`, `scopes`). Secret fields (`bindPassword`, `clientSecret`) are stored encrypted at rest via `encryptionService` and are never returned in plaintext by the admin API.
- `default_role`: Role (`user` | `view-only`) assigned to a directory account the first time it logs in (JIT provisioning). Deliberately cannot be `admin`.
- `updated_at`: Last modification timestamp.

## 🏭 Historian Database (AVEVA / External)
Accessed via read-only SQL connections.
- **Live Table**: Real-time snapshots.
- **History Table**: Historical time-series data.
