// Use type-only import so the 'better-sqlite3' native addon is NOT loaded at
// module-init time.  The actual require() is deferred into the lazy getter below,
// matching the pattern used by brandingService and other services that share auth.db.
import type Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDatabasePath } from '@/config/environment';
import { encryptionService, EncryptedData } from '@/services/encryptionService';

export type IdentityProviderId = 'ldap' | 'oidc';
export type JitDefaultRole = 'user' | 'view-only';

export interface LdapProviderConfig {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  tlsRejectUnauthorized: boolean;
  caCert: string;
}

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

export type ProviderConfigMap = {
  ldap: LdapProviderConfig;
  oidc: OidcProviderConfig;
};

export interface IdentityProviderRecord<T extends IdentityProviderId = IdentityProviderId> {
  id: T;
  enabled: boolean;
  config: ProviderConfigMap[T];
  defaultRole: JitDefaultRole;
  updatedAt: string;
}

// Like `Partial<T>`, but explicitly allows `undefined` on every field. Plain `Partial<T>` under
// this project's `exactOptionalPropertyTypes: true` means "may be omitted, but if present must
// be exactly T" — which rejects the shape zod's `.partial()` schemas actually produce
// (`{ field?: string | undefined }`) at the call sites in identityProviders.ts.
type LooseConfigUpdate<T> = { [K in keyof T]?: T[K] | undefined };

const SECRET_FIELDS: { [K in IdentityProviderId]: (keyof ProviderConfigMap[K])[] } = {
  ldap: ['bindPassword'],
  oidc: ['clientSecret']
};

const MASK = '••••••••';

interface EncryptedMarker {
  __encrypted: true;
  value: EncryptedData;
}

function isEncryptedMarker(value: unknown): value is EncryptedMarker {
  return typeof value === 'object' && value !== null && (value as EncryptedMarker).__encrypted === true;
}

function openDb(): Database.Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Ctor = require('better-sqlite3') as { new(path: string): Database.Database };
  const dbPath = getDatabasePath('auth.db');
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = new Ctor(dbPath);
  db.pragma('busy_timeout = 10000');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_providers (
      id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      default_role TEXT NOT NULL DEFAULT 'view-only',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

class IdentityProviderService {
  private _db: Database.Database | null = null;

  private get db(): Database.Database {
    if (!this._db) this._db = openDb();
    return this._db;
  }

  private encryptSecrets<T extends IdentityProviderId>(id: T, config: Record<string, unknown>): Record<string, unknown> {
    const out = { ...config };
    for (const field of SECRET_FIELDS[id] as string[]) {
      const value = out[field];
      if (typeof value === 'string' && value.length > 0) {
        out[field] = { __encrypted: true, value: encryptionService.encrypt(value) } satisfies EncryptedMarker;
      }
    }
    return out;
  }

  private decryptSecrets<T extends IdentityProviderId>(id: T, config: Record<string, unknown>): Record<string, unknown> {
    const out = { ...config };
    for (const field of SECRET_FIELDS[id] as string[]) {
      const value = out[field];
      if (isEncryptedMarker(value)) {
        out[field] = encryptionService.decrypt(value.value);
      }
    }
    return out;
  }

  /** Secrets decrypted — internal/server use only (e.g. LdapProvider/OidcProvider). Never send to the client. */
  getConfig<T extends IdentityProviderId>(id: T): IdentityProviderRecord<T> | null {
    const row = this.db.prepare('SELECT * FROM identity_providers WHERE id = ?').get(id) as
      { id: T; enabled: number; config: string; default_role: JitDefaultRole; updated_at: string } | undefined;
    if (!row) return null;
    const rawConfig = JSON.parse(row.config || '{}') as Record<string, unknown>;
    return {
      id,
      enabled: Boolean(row.enabled),
      config: this.decryptSecrets(id, rawConfig) as unknown as ProviderConfigMap[T],
      defaultRole: row.default_role,
      updatedAt: row.updated_at
    };
  }

  /** Secrets masked to a fixed placeholder — safe to return from the admin config API. */
  getMaskedConfig<T extends IdentityProviderId>(id: T): IdentityProviderRecord<T> | null {
    const record = this.getConfig(id);
    if (!record) return null;
    const masked = { ...(record.config as unknown as Record<string, unknown>) };
    for (const field of SECRET_FIELDS[id] as string[]) {
      if (masked[field]) masked[field] = MASK;
    }
    return { ...record, config: masked as unknown as ProviderConfigMap[T] };
  }

  /**
   * Merges partial updates into the stored config. If a secret field arrives holding the
   * mask placeholder unchanged (the admin didn't touch it), the previously stored secret is
   * kept rather than overwritten — callers should always feed this function what the client
   * submitted, including an untouched masked value.
   */
  updateConfig<T extends IdentityProviderId>(
    id: T,
    updates: {
      enabled?: boolean | undefined;
      config?: LooseConfigUpdate<ProviderConfigMap[T]> | undefined;
      defaultRole?: JitDefaultRole | undefined;
    }
  ): IdentityProviderRecord<T> {
    const existing = this.getConfig(id);
    const mergedConfig: Record<string, unknown> = {
      ...(existing?.config as unknown as Record<string, unknown> || {}),
      ...(updates.config as Record<string, unknown> || {})
    };

    for (const field of SECRET_FIELDS[id] as string[]) {
      if (mergedConfig[field] === MASK) {
        mergedConfig[field] = (existing?.config as unknown as Record<string, unknown>)?.[field] ?? '';
      }
    }

    const enabled = updates.enabled ?? existing?.enabled ?? false;
    const defaultRole = updates.defaultRole ?? existing?.defaultRole ?? 'view-only';
    const toStore = this.encryptSecrets(id, mergedConfig);

    this.db.prepare(`
      INSERT INTO identity_providers (id, enabled, config, default_role, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        config = excluded.config,
        default_role = excluded.default_role,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, enabled ? 1 : 0, JSON.stringify(toStore), defaultRole);

    return this.getConfig(id)!;
  }

  isEnabled(id: IdentityProviderId): boolean {
    return this.getConfig(id)?.enabled ?? false;
  }

  listMaskedProviders(): IdentityProviderRecord[] {
    return (['ldap', 'oidc'] as IdentityProviderId[])
      .map(id => this.getMaskedConfig(id))
      .filter((r): r is IdentityProviderRecord => r !== null);
  }
}

export const identityProviderService = new IdentityProviderService();
