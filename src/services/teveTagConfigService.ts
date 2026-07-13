// Same lazy-require pattern as brandingService.ts / teveConfigService.ts.
import type Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDatabasePath } from '@/config/environment';

export interface TeveHistorizeTag {
  nodeId: string;
  tagName: string;
  unit: string | null;
  createdAt: string;
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
    CREATE TABLE IF NOT EXISTS teve_historize_tags (
      node_id    TEXT PRIMARY KEY,
      tag_name   TEXT NOT NULL,
      unit       TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

/**
 * Admin-configured list of OPC UA tags that should be continuously historized into
 * TEVE (see teveIngestService.ts). Distinct from alert-monitored
 * tags (alertEvalService.ts) — a tag can be historized, alerted on, both, or neither.
 */
class TeveTagConfigService {
  private _db: Database.Database | null = null;

  private get db(): Database.Database {
    if (!this._db) this._db = openDb();
    return this._db;
  }

  list(): TeveHistorizeTag[] {
    const rows = this.db.prepare('SELECT node_id, tag_name, unit, created_at FROM teve_historize_tags ORDER BY created_at').all() as any[];
    return rows.map((r) => ({ nodeId: r.node_id, tagName: r.tag_name, unit: r.unit, createdAt: r.created_at }));
  }

  add(nodeId: string, tagName: string, unit?: string | null): void {
    this.db.prepare(`
      INSERT INTO teve_historize_tags (node_id, tag_name, unit)
      VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET tag_name = excluded.tag_name, unit = excluded.unit
    `).run(nodeId, tagName, unit ?? null);
  }

  remove(nodeId: string): void {
    this.db.prepare('DELETE FROM teve_historize_tags WHERE node_id = ?').run(nodeId);
  }
}

export const teveTagConfigService = new TeveTagConfigService();
