import { Client } from 'ldapts';
import type { Entry } from 'ldapts';
import { apiLogger } from '@/utils/logger';
import type { LdapProviderConfig } from '@/services/identityProviderService';
import { ExternalUserProfile, LdapAuthResult, ConnectionTestResult } from '@/services/identity/IdentityProvider';

/**
 * Escapes a value for safe interpolation into an LDAP search filter, per RFC 4515.
 * MUST be applied to every user-supplied value (the login-form username, primarily) before
 * it's placed into a filter template — ldapts does not do this for you. Without it, a
 * username like `*)(uid=*))(|(uid=*` could widen or short-circuit the search (LDAP injection).
 */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => {
    switch (char) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      case '\0': return '\\00';
      default: return char;
    }
  });
}

function firstString(value: Entry[string] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : undefined;
}

function stringArray(value: Entry[string] | undefined): string[] {
  const arr = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  return arr.filter((v): v is string => typeof v === 'string');
}

/**
 * A stable identifier for the JIT-provisioned user record, preferred in this order: AD's
 * binary `objectGUID` (requested as a Buffer via `explicitBufferAttributes`), then
 * `entryUUID` (standard on OpenLDAP and most non-AD directories), then the DN itself as a
 * last resort (stable within one directory instance, though not portable across directory
 * migrations — acceptable for a single-tenant deployment).
 */
function resolveExternalId(entry: Entry): string {
  const guid = entry.objectGUID;
  if (Buffer.isBuffer(guid)) return `guid:${guid.toString('hex')}`;
  const uuid = firstString(entry.entryUUID);
  if (uuid) return `uuid:${uuid}`;
  return `dn:${entry.dn}`;
}

export class LdapProvider {
  constructor(private readonly config: LdapProviderConfig) {}

  private buildClient(): Client {
    return new Client({
      url: this.config.url,
      tlsOptions: {
        rejectUnauthorized: this.config.tlsRejectUnauthorized,
        ...(this.config.caCert ? { ca: [this.config.caCert] } : {})
      }
    });
  }

  private buildUserFilter(username: string): string {
    return this.config.userFilter.replace('{{username}}', escapeLdapFilter(username));
  }

  private hostFromUrl(): string {
    try {
      return new URL(this.config.url).hostname;
    } catch {
      return 'ldap.local';
    }
  }

  /** Service-account bind + a bounded search, without requiring a real user to test against. */
  async testConnection(): Promise<ConnectionTestResult> {
    const client = this.buildClient();
    try {
      await client.bind(this.config.bindDn, this.config.bindPassword);
      await client.search(this.config.baseDn, { scope: 'base', sizeLimit: 1 });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'LDAP connection test failed' };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async authenticate(username: string, password: string): Promise<LdapAuthResult> {
    if (!password) {
      // An empty password is an *unauthenticated* bind per the LDAP protocol, which servers
      // accept as anonymous success — never let an empty submitted password reach a bind call.
      return { success: false, error: 'Invalid username or password' };
    }

    let userDn: string;
    let profile: ExternalUserProfile;
    const searchClient = this.buildClient();
    try {
      await searchClient.bind(this.config.bindDn, this.config.bindPassword);

      const { searchEntries } = await searchClient.search(this.config.baseDn, {
        scope: 'sub',
        filter: this.buildUserFilter(username),
        sizeLimit: 2,
        explicitBufferAttributes: ['objectGUID']
      });

      if (searchEntries.length === 0) {
        return { success: false, error: 'Invalid username or password' };
      }
      if (searchEntries.length > 1) {
        apiLogger.error('LDAP user search matched multiple entries — refusing to authenticate', { username });
        return { success: false, error: 'Invalid username or password' };
      }

      const entry = searchEntries[0]!;
      userDn = entry.dn;
      profile = {
        externalId: resolveExternalId(entry),
        username,
        email: firstString(entry.mail) ?? `${username}@${this.hostFromUrl()}`,
        firstName: firstString(entry.givenName) ?? username,
        lastName: firstString(entry.sn) ?? '',
        groups: stringArray(entry.memberOf)
      };
    } catch (error) {
      apiLogger.error('LDAP user search failed', { error, username });
      return { success: false, error: 'Invalid username or password' };
    } finally {
      await searchClient.unbind().catch(() => undefined);
    }

    // The actual authentication check: rebind as the resolved user DN with the password the
    // user submitted. No password ever touches the app's own bcrypt hashing.
    const userClient = this.buildClient();
    try {
      await userClient.bind(userDn, password);
      return { success: true, profile };
    } catch {
      return { success: false, error: 'Invalid username or password' };
    } finally {
      await userClient.unbind().catch(() => undefined);
    }
  }
}
