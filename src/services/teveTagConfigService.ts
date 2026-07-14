// Same lazy-require pattern as brandingService.ts / teveConfigService.ts.
import type Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDatabasePath } from '@/config/environment';

export interface TeveHistorizeTag {
  nodeId: string;
  /** OPC UA connection the node lives on; null = unqualified legacy tag. */
  connectionId: string | null;
  tagName: string;
  unit: string | null;
  createdAt: string;
}

// The composite primary key can't contain NULL, so unqualified legacy rows
// store '' for connection_id and the API maps it back to null.
const NO_CONNECTION = '';

function openDb(): Database.Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Ctor = require('better-sqlite3') as { new(path: string): Database.Database };
  const dbPath = getDatabasePath('auth.db');
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = new Ctor(dbPath);
  db.pragma('busy_timeout = 10000');
  db.pragma('journal_mode = WAL');
  // v2: keyed by (connection_id, node_id) — the same nodeId may legitimately
  // exist on multiple PLCs. v1 rows (PK node_id only) are copied over once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS teve_historize_tags_v2 (
      connection_id TEXT NOT NULL DEFAULT '',
      node_id       TEXT NOT NULL,
      tag_name      TEXT NOT NULL,
      unit          TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (connection_id, node_id)
    )
  `);
  const hasV1 = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'teve_historize_tags'")
    .get();
  if (hasV1) {
    db.exec(`
      INSERT OR IGNORE INTO teve_historize_tags_v2 (connection_id, node_id, tag_name, unit, created_at)
      SELECT '', node_id, tag_name, unit, created_at FROM teve_historize_tags
    `);
    db.exec('DROP TABLE teve_historize_tags');
  }
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
    const rows = this.db.prepare(
      'SELECT connection_id, node_id, tag_name, unit, created_at FROM teve_historize_tags_v2 ORDER BY created_at'
    ).all() as any[];
    return rows.map((r) => ({
      nodeId: r.node_id,
      connectionId: r.connection_id === NO_CONNECTION ? null : r.connection_id,
      tagName: r.tag_name,
      unit: r.unit,
      createdAt: r.created_at,
    }));
  }

  add(nodeId: string, tagName: string, unit?: string | null, connectionId?: string | null): void {
    this.db.prepare(`
      INSERT INTO teve_historize_tags_v2 (connection_id, node_id, tag_name, unit)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(connection_id, node_id) DO UPDATE SET tag_name = excluded.tag_name, unit = excluded.unit
    `).run(connectionId ?? NO_CONNECTION, nodeId, tagName, unit ?? null);
  }

  remove(nodeId: string, connectionId?: string | null): void {
    this.db.prepare(
      'DELETE FROM teve_historize_tags_v2 WHERE connection_id = ? AND node_id = ?'
    ).run(connectionId ?? NO_CONNECTION, nodeId);
  }

  /** One-shot migration: bind all unqualified rows to a connection. Returns rows changed. */
  assignConnectionToUnqualified(connectionId: string): number {
    const result = this.db.prepare(`
      UPDATE OR IGNORE teve_historize_tags_v2 SET connection_id = ? WHERE connection_id = ''
    `).run(connectionId);
    return result.changes;
  }

  /** Historize tags not bound to any connection (only ingested via the legacy default). */
  countUnqualified(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM teve_historize_tags_v2 WHERE connection_id = ''"
    ).get() as any;
    return row?.count ?? 0;
  }

  /**
   * Unbinds rows referencing a deleted connection. UPDATE OR IGNORE skips rows
   * whose (''||node_id) slot is already taken by an existing unqualified row;
   * those leftovers are duplicates and get deleted. Returns rows affected.
   */
  clearConnectionReferences(connectionId: string): number {
    const updated = this.db.prepare(
      "UPDATE OR IGNORE teve_historize_tags_v2 SET connection_id = '' WHERE connection_id = ?"
    ).run(connectionId);
    const deleted = this.db.prepare(
      'DELETE FROM teve_historize_tags_v2 WHERE connection_id = ?'
    ).run(connectionId);
    return updated.changes + deleted.changes;
  }
}

export const teveTagConfigService = new TeveTagConfigService();
