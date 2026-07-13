// Same lazy-require pattern as brandingService.ts: defers loading the 'better-sqlite3'
// native addon until first use, and shares its site_settings table in auth.db.
import type Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDatabasePath } from '@/config/environment';

export interface TeveConfig {
  enabled: boolean;
  baseUrl: string;
}

const DEFAULTS: TeveConfig = {
  // Off by default: the Tensor Historian is a separate, optional service in its own
  // container(s) — most deployments won't have it, so nothing should assume it exists
  // until an admin explicitly configures and enables it.
  enabled: false,
  baseUrl: '',
};

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
    CREATE TABLE IF NOT EXISTS site_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

class TeveConfigService {
  private _db: Database.Database | null = null;

  private get db(): Database.Database {
    if (!this._db) this._db = openDb();
    return this._db;
  }

  private get(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
  }

  private set(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
  }

  getConfig(): TeveConfig {
    return {
      enabled: this.get('teveEnabled', String(DEFAULTS.enabled)) === 'true',
      baseUrl: this.get('teveBaseUrl', DEFAULTS.baseUrl),
    };
  }

  updateConfig(updates: Partial<TeveConfig>): TeveConfig {
    if (updates.enabled !== undefined) this.set('teveEnabled', String(updates.enabled));
    if (updates.baseUrl !== undefined) this.set('teveBaseUrl', updates.baseUrl.trim().replace(/\/+$/, ''));
    return this.getConfig();
  }

  /** Config usable for proxying: only when enabled AND a base URL is actually set. */
  getActiveBaseUrl(): string | null {
    const { enabled, baseUrl } = this.getConfig();
    return enabled && baseUrl ? baseUrl : null;
  }
}

export const teveConfigService = new TeveConfigService();
