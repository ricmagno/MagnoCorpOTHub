// Use type-only import so the 'better-sqlite3' native addon is NOT loaded at
// module-init time.  The actual require() is deferred into the lazy getter below,
// matching the pattern used by schedulerService and other services that share auth.db.
import type Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDatabasePath } from '@/config/environment';

export interface BrandingSettings {
  companyName: string;
  appName: string;
  siteName: string;
  primaryColor: string;
  accentColor: string;
  website: string;
  reportFooter: string;
  emailSenderName: string;
}

const DEFAULTS: BrandingSettings = {
  companyName: 'MagnoCorp',
  appName: 'OT Hub',
  siteName: '',
  primaryColor: '#2563EB',
  accentColor: '#7C3AED',
  website: 'https://www.magnocorp.com',
  reportFooter: '',
  emailSenderName: 'OT Hub'
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

class BrandingService {
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

  getSettings(): BrandingSettings {
    return {
      companyName:     this.get('companyName',     DEFAULTS.companyName),
      appName:         this.get('appName',         DEFAULTS.appName),
      siteName:        this.get('siteName',        DEFAULTS.siteName),
      primaryColor:    this.get('primaryColor',    DEFAULTS.primaryColor),
      accentColor:     this.get('accentColor',     DEFAULTS.accentColor),
      website:         this.get('website',         DEFAULTS.website),
      reportFooter:    this.get('reportFooter',    DEFAULTS.reportFooter),
      emailSenderName: this.get('emailSenderName', DEFAULTS.emailSenderName)
    };
  }

  updateSettings(updates: Partial<BrandingSettings>): BrandingSettings {
    const allowed = Object.keys(DEFAULTS) as (keyof BrandingSettings)[];
    for (const key of allowed) {
      if (key in updates && updates[key] !== undefined) {
        this.set(key, updates[key]!);
      }
    }
    return this.getSettings();
  }

  getLogo(): string {
    return this.get('logo');
  }

  setLogo(dataUrl: string): void {
    this.set('logo', dataUrl);
  }

  hasLogo(): boolean {
    return this.getLogo().length > 0;
  }

  getDisplayName(): string {
    const s = this.getSettings();
    const parts = [s.companyName, s.appName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'OT Hub';
  }
}

export const brandingService = new BrandingService();
