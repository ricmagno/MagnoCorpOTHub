/**
 * Authentication Service
 * Handles user authentication, JWT tokens, and session management
 * Requirements: 9.1, 9.5
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { apiLogger } from '@/utils/logger';
import { env, getDatabasePath } from '@/config/environment';
import { encryptionService } from '@/services/encryptionService';
import { userManagementService } from '@/services/userManagementService';
import { ExternalUserProfile, IdentityProviderType } from '@/services/identity/IdentityProvider';

export interface User {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'user' | 'admin' | 'view-only';
  passwordHash: string;
  isActive: boolean;
  lastLogin?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
  parentUserId?: string | null;
  isViewOnly: boolean;
  autoLoginEnabled: boolean;
  requirePasswordChange: boolean;
  authProvider: 'local' | 'ldap' | 'oidc';
  externalId?: string | null;
  externalLastSync?: Date | undefined;
}

export interface UserSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  isActive: boolean;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthResult {
  success: boolean;
  user?: Omit<User, 'passwordHash'>;
  token?: string;
  expiresIn?: string;
  error?: string;
}

export interface Permission {
  resource: string;
  action: string;
  granted: boolean;
}

export class AuthService {
  public db!: Database.Database;
  private jwtSecret: string;
  private tokenExpiry: string = '24h';
  private refreshTokenExpiry: string = '30d';

  constructor() {
    this.jwtSecret = env.JWT_SECRET;
    this.initializeDatabase();
  }

  async waitForInitialization(): Promise<void> {
    // Synchronous init — no-op
  }

  private initializeDatabase(): void {
    const dbPath = getDatabasePath('auth.db');
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('busy_timeout = 10000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        email TEXT UNIQUE NOT NULL COLLATE NOCASE,
        mobile TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        password_hash TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        is_view_only BOOLEAN DEFAULT 0,
        parent_user_id TEXT,
        auto_login_enabled BOOLEAN DEFAULT 0,
        require_password_change BOOLEAN DEFAULT 0,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        user_agent TEXT,
        ip_address TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        resource TEXT NOT NULL,
        action TEXT NOT NULL,
        granted BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    // Column migrations
    const columns = this.db.pragma('table_info(users)') as any[];
    const columnNames = columns.map(col => col.name);
    const migrations = [
      { name: 'mobile', type: 'TEXT' },
      { name: 'is_view_only', type: 'BOOLEAN DEFAULT 0' },
      { name: 'parent_user_id', type: 'TEXT' },
      { name: 'auto_login_enabled', type: 'BOOLEAN DEFAULT 0' },
      { name: 'require_password_change', type: 'BOOLEAN DEFAULT 0' },
      { name: 'auth_provider', type: "TEXT DEFAULT 'local'" },
      { name: 'external_id', type: 'TEXT' },
      { name: 'external_last_sync', type: 'DATETIME' }
    ];
    for (const migration of migrations) {
      if (!columnNames.includes(migration.name)) {
        try {
          this.db.exec(`ALTER TABLE users ADD COLUMN ${migration.name} ${migration.type}`);
          apiLogger.info(`Added ${migration.name} column to users table`);
        } catch (err) {
          apiLogger.error(`Failed to add ${migration.name} column to users table`, { error: err });
        }
      }
    }

    // Prevents the same directory account from being JIT-provisioned twice under a race.
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_external
      ON users(auth_provider, external_id) WHERE external_id IS NOT NULL
    `);

    this.createDefaultPermissions();
    apiLogger.info('Authentication database initialized and tables created');
  }

  private createDefaultPermissions(): void {
    const permissions = [
      { role: 'admin' as const, resource: 'reports', action: 'read' },
      { role: 'admin' as const, resource: 'reports', action: 'write' },
      { role: 'admin' as const, resource: 'reports', action: 'delete' },
      { role: 'admin' as const, resource: 'schedules', action: 'read' },
      { role: 'admin' as const, resource: 'schedules', action: 'write' },
      { role: 'admin' as const, resource: 'schedules', action: 'delete' },
      { role: 'admin' as const, resource: 'users', action: 'read' },
      { role: 'admin' as const, resource: 'users', action: 'write' },
      { role: 'admin' as const, resource: 'users', action: 'delete' },
      { role: 'admin' as const, resource: 'system', action: 'read' },
      { role: 'admin' as const, resource: 'system', action: 'write' },
      { role: 'admin' as const, resource: 'system', action: 'delete' },
      { role: 'user' as const, resource: 'reports', action: 'read' },
      { role: 'user' as const, resource: 'reports', action: 'write' },
      { role: 'user' as const, resource: 'reports', action: 'delete' },
      { role: 'user' as const, resource: 'schedules', action: 'read' },
      { role: 'user' as const, resource: 'schedules', action: 'write' },
      { role: 'user' as const, resource: 'schedules', action: 'delete' },
      { role: 'user' as const, resource: 'system', action: 'read' },
      { role: 'view-only' as const, resource: 'reports', action: 'read' },
      { role: 'view-only' as const, resource: 'schedules', action: 'read' },
      { role: 'view-only' as const, resource: 'system', action: 'read' }
    ];

    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO role_permissions (id, role, resource, action, granted) VALUES (?, ?, ?, ?, ?)'
    );
    for (const perm of permissions) {
      const permId = `perm_${perm.role}_${perm.resource}_${perm.action}`;
      stmt.run(permId, perm.role, perm.resource, perm.action, 1);
    }
  }

  async authenticate(usernameOrEmail: string, password: string, rememberMe: boolean = false): Promise<AuthResult> {
    try {
      const row = this.db.prepare(
        'SELECT * FROM users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND is_active = 1'
      ).get(usernameOrEmail, usernameOrEmail) as any;

      if (!row) {
        await this.logAuditEvent(null, 'login_failed', 'auth', `Failed login attempt for: ${usernameOrEmail}`);
        return { success: false, error: 'Invalid username or password' };
      }

      const user = this.rowToUser(row);
      const passwordValid = await bcrypt.compare(password, user.passwordHash);
      if (!passwordValid) {
        await this.logAuditEvent(user.id, 'login_failed', 'auth', 'Invalid password');
        return { success: false, error: 'Invalid username or password' };
      }

      await this.logAuditEvent(user.id, 'login_success', 'auth', 'User logged in successfully');
      return this.issueSession(user, rememberMe);
    } catch (error) {
      apiLogger.error('Authentication failed', { error, usernameOrEmail });
      return { success: false, error: 'Authentication failed' };
    }
  }

  /**
   * Issues a token + server-tracked session for an already-authenticated user, and updates
   * their last-login timestamp. This is the sole exit point both local password auth
   * (`authenticate()`) and SSO auth (`completeSsoLogin()`) funnel through, so an SSO-issued
   * JWT is indistinguishable from a local one at verification time (`verifyToken()`) — no
   * changes are needed anywhere else (middleware, logout, session revocation) to support SSO.
   */
  private issueSession(user: User, rememberMe: boolean): AuthResult {
    const expiresIn = rememberMe ? this.refreshTokenExpiry : this.tokenExpiry;
    const token = this.generateToken(user, expiresIn);
    this.createSession(user.id, token, expiresIn);
    this.updateLastLogin(user.id);

    const { passwordHash, ...userWithoutPassword } = user;
    return { success: true, user: userWithoutPassword, token, expiresIn };
  }

  /**
   * Completes an SSO login (LDAP bind success or OIDC callback) given a normalized external
   * profile. JIT-provisions a local user record on first login; reuses the identical
   * token-issuing path as local login on subsequent ones.
   *
   * Deliberately does NOT fall back to matching an existing *local* account by email/username
   * — a directory account with a matching email could otherwise silently take over a
   * pre-existing local account (including potentially an admin one). Account linking, if ever
   * needed, should be an explicit admin action, not automatic.
   */
  async completeSsoLogin(profile: ExternalUserProfile, provider: IdentityProviderType): Promise<AuthResult> {
    try {
      const existingRow = this.db.prepare(
        'SELECT * FROM users WHERE auth_provider = ? AND external_id = ? AND is_active = 1'
      ).get(provider, profile.externalId) as any;

      if (existingRow) {
        const user = this.rowToUser(existingRow);
        this.db.prepare(`UPDATE users SET external_last_sync = datetime('now') WHERE id = ?`).run(user.id);
        await this.logAuditEvent(user.id, 'login_success', 'auth', `User logged in via ${provider} SSO`);
        return this.issueSession(user, false);
      }

      const conflictRow = this.db.prepare(
        `SELECT id FROM users WHERE auth_provider = 'local' AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)`
      ).get(profile.username, profile.email) as any;

      if (conflictRow) {
        await this.logAuditEvent(
          null, 'sso_login_conflict', 'auth',
          `SSO login blocked: a local account already exists for ${profile.username}/${profile.email}`
        );
        return { success: false, error: 'account_conflict' };
      }

      const newUser = await userManagementService.createSsoUser(profile, provider);
      const fullUser = await this.getUserById(newUser.id);
      if (!fullUser) return { success: false, error: 'Failed to provision user' };

      await this.logAuditEvent(fullUser.id, 'sso_user_provisioned', 'auth', `User JIT-provisioned via ${provider} SSO`);
      return this.issueSession(fullUser, false);
    } catch (error) {
      apiLogger.error('SSO login failed', { error, provider, externalId: profile.externalId });
      return { success: false, error: 'SSO authentication failed' };
    }
  }

  private generateToken(user: User, expiresIn: string): string {
    const payload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      iat: Math.floor(Date.now() / 1000),
      jti: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    return jwt.sign(payload, this.jwtSecret, { expiresIn } as jwt.SignOptions);
  }

  async verifyToken(token: string): Promise<{ valid: boolean; user?: Omit<User, 'passwordHash'>; error?: string }> {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as any;

      const sessionRow = this.db.prepare(
        `SELECT id FROM user_sessions WHERE token = ? AND is_active = 1 AND expires_at > datetime('now')`
      ).get(token);

      if (!sessionRow) {
        return { valid: false, error: 'Session expired or invalid' };
      }

      const user = await this.getUserById(decoded.userId);
      if (!user || !user.isActive) {
        return { valid: false, error: 'User not found or inactive' };
      }

      const { passwordHash, ...userWithoutPassword } = user;
      return { valid: true, user: userWithoutPassword };
    } catch (error) {
      return { valid: false, error: 'Invalid token' };
    }
  }

  private createSession(userId: string, token: string, expiresIn: string): void {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date();
    const match = expiresIn.match(/^(\d+)([hdm])$/);
    if (match && match[1]) {
      const value = parseInt(match[1]);
      switch (match[2]) {
        case 'h': expiresAt.setHours(expiresAt.getHours() + value); break;
        case 'd': expiresAt.setDate(expiresAt.getDate() + value); break;
        case 'm': expiresAt.setMinutes(expiresAt.getMinutes() + value); break;
      }
    } else {
      expiresAt.setHours(expiresAt.getHours() + 24);
    }
    this.db.prepare(
      'INSERT INTO user_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, userId, token, expiresAt.toISOString());
  }

  async logout(token: string): Promise<boolean> {
    try {
      const decoded = jwt.decode(token) as any;
      this.db.prepare('UPDATE user_sessions SET is_active = 0 WHERE token = ?').run(token);
      if (decoded?.userId) {
        await this.logAuditEvent(decoded.userId, 'logout', 'auth', 'User logged out');
      }
      return true;
    } catch (error) {
      apiLogger.error('Logout failed', { error });
      return false;
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    return row ? this.rowToUser(row) : null;
  }

  /**
   * Used by the login route to decide whether to attempt local password auth or fall through
   * to an SSO provider — a lightweight existence check, not an auth decision itself. Local
   * accounts always take this path first so existing local logins never get silently retried
   * against a directory (no behavior change for local users once SSO is configured).
   */
  hasActiveLocalAccount(usernameOrEmail: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND auth_provider = 'local' AND is_active = 1`
    ).get(usernameOrEmail, usernameOrEmail);
    return !!row;
  }

  async hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
    try {
      const user = await this.getUserById(userId);
      if (!user || !user.isActive) return false;
      const row = this.db.prepare(
        'SELECT granted FROM role_permissions WHERE role = ? AND resource = ? AND action = ?'
      ).get(user.role, resource, action) as any;
      return row ? Boolean(row.granted) : false;
    } catch (error) {
      apiLogger.error('Permission check failed', { error, userId, resource, action });
      return false;
    }
  }

  async getUserPermissions(userId: string): Promise<Permission[]> {
    try {
      const user = await this.getUserById(userId);
      if (!user || !user.isActive) return [];
      const rows = this.db.prepare(
        'SELECT resource, action, granted FROM role_permissions WHERE role = ?'
      ).all(user.role) as any[];
      return rows.map(row => ({ resource: row.resource, action: row.action, granted: Boolean(row.granted) }));
    } catch (error) {
      apiLogger.error('Failed to get user permissions', { error, userId });
      return [];
    }
  }

  private updateLastLogin(userId: string): void {
    this.db.prepare(
      `UPDATE users SET last_login = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(userId);
  }

  async logAuditEvent(
    userId: string | null,
    action: string,
    resource: string,
    details: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const encryptedDetails = encryptionService.encrypt(details);
    const encryptedUserAgent = userAgent ? encryptionService.encrypt(userAgent) : null;
    this.db.prepare(
      'INSERT INTO audit_logs (id, user_id, action, resource, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      auditId, userId, action, resource,
      JSON.stringify(encryptedDetails),
      ipAddress || null,
      encryptedUserAgent ? JSON.stringify(encryptedUserAgent) : null
    );
  }

  async getAuditLogs(
    limit: number = 100,
    offset: number = 0,
    userId?: string,
    action?: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<any[]> {
    let query = `
      SELECT al.*, u.username, u.email
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (userId) { query += ' AND al.user_id = ?'; params.push(userId); }
    if (action) { query += ' AND al.action = ?'; params.push(action); }
    if (startDate) { query += ' AND al.timestamp >= ?'; params.push(startDate.toISOString()); }
    if (endDate) { query += ' AND al.timestamp <= ?'; params.push(endDate.toISOString()); }
    query += ' ORDER BY al.timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => {
      try {
        let decryptedDetails = row.details;
        let decryptedUserAgent = row.user_agent;
        if (row.details?.startsWith('{')) {
          try { decryptedDetails = encryptionService.decrypt(JSON.parse(row.details)); } catch { /* keep original */ }
        }
        if (row.user_agent?.startsWith('{')) {
          try { decryptedUserAgent = encryptionService.decrypt(JSON.parse(row.user_agent)); } catch { /* keep original */ }
        }
        return {
          id: row.id, userId: row.user_id, username: row.username, email: row.email,
          action: row.action, resource: row.resource, details: decryptedDetails,
          ipAddress: row.ip_address, userAgent: decryptedUserAgent, timestamp: new Date(row.timestamp)
        };
      } catch (error) {
        apiLogger.error('Failed to decrypt audit log entry', { error, logId: row.id });
        return {
          id: row.id, userId: row.user_id, username: row.username, email: row.email,
          action: row.action, resource: row.resource, details: '[ENCRYPTED]',
          ipAddress: row.ip_address, userAgent: '[ENCRYPTED]', timestamp: new Date(row.timestamp)
        };
      }
    });
  }

  async cleanupExpiredSessions(): Promise<void> {
    this.db.prepare(`DELETE FROM user_sessions WHERE expires_at < datetime('now') OR is_active = 0`).run();
    apiLogger.info('Expired sessions cleaned up');
  }

  async shutdown(): Promise<void> {
    this.db.close();
    apiLogger.info('Auth service shutdown');
  }

  private rowToUser(row: any): User {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      passwordHash: row.password_hash,
      isActive: Boolean(row.is_active),
      lastLogin: row.last_login ? new Date(row.last_login) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      parentUserId: row.parent_user_id || null,
      isViewOnly: Boolean(row.is_view_only),
      autoLoginEnabled: Boolean(row.auto_login_enabled),
      requirePasswordChange: Boolean(row.require_password_change),
      authProvider: (row.auth_provider || 'local') as 'local' | 'ldap' | 'oidc',
      externalId: row.external_id || null,
      externalLastSync: row.external_last_sync ? new Date(row.external_last_sync) : undefined
    };
  }
}

export const authService = new AuthService();
