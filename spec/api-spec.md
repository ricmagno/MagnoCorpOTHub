# API Specification

This document defines the core API endpoints for the Historian Reports backend.

## 🔐 Authentication
- `POST /api/auth/login`: Authenticate user and return JWT. If the submitted username has no active local account and an identity provider is enabled, falls through to that provider (LDAP bind, currently; OIDC pending) before failing.
- `POST /api/auth/logout`: Invalidate session.

## 🪪 Identity Providers
- `GET /api/identity-providers`: List configured identity providers (`ldap`, `oidc`) with secrets masked (Admin only).
- `PUT /api/identity-providers/:id`: Update one provider's configuration — enabled flag, JIT default role (`user` | `view-only`, never `admin`), and provider-specific connection settings (Admin only).
- `POST /api/identity-providers/:id/test`: Test connectivity for a provider's saved configuration without requiring a real end-user login (Admin only). LDAP only for now; OIDC returns 501 until that provider is implemented.

## 📊 Data & Reports
- `POST /api/data/query`: Query historical data from Historian.
- `GET /api/reports`: List all report configurations.
- `POST /api/reports/generate`: Trigger manual PDF generation.
- `GET /api/reports/:id/download`: Download a generated PDF.

## ⚙️ Configuration
- `GET /api/configuration`: Fetch global settings.
- `PUT /api/configuration`: Update settings (DB connections, SMTP, etc.).
- `GET /api/database-config`: Manage Historian SQL connections.
- `GET /api/opcua-config`: Manage OPC UA server connections.

## 🕒 Schedules
- `GET /api/schedules`: List automated report schedules.
- `POST /api/schedules`: Create/Update a schedule.

## 👤 User Management
- `GET /api/users`: List system users (Admin only).
- `POST /api/users`: Manage user roles and permissions.
