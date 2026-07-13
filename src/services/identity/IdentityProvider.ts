/**
 * Shared types for external identity providers (LDAP, OIDC).
 *
 * LDAP and OIDC are intentionally NOT forced into one identical `.authenticate()` shape:
 * LDAP is a direct credential exchange (bind-and-search, synchronous request/response),
 * OIDC is a redirect handshake (authorization URL -> browser round-trip -> callback). Trying
 * to unify those into one method would be a false abstraction. They only converge at the exit
 * point: both funnel an `ExternalUserProfile` into `authService.completeSsoLogin()`.
 */

export type IdentityProviderType = 'ldap' | 'oidc';

/**
 * Normalized profile handed to `authService.completeSsoLogin()` regardless of which provider
 * produced it.
 */
export interface ExternalUserProfile {
  /** Stable directory identifier — AD objectGUID / OIDC `sub`. Never the username (which can change). */
  externalId: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  /** memberOf CNs (LDAP) or a groups claim (OIDC), kept for future group->role mapping. Not used for JIT role assignment today. */
  groups?: string[];
}

export interface ProviderAuthError {
  success: false;
  error: string;
}

export interface LdapAuthSuccess {
  success: true;
  profile: ExternalUserProfile;
}

export type LdapAuthResult = LdapAuthSuccess | ProviderAuthError;

export interface ConnectionTestResult {
  success: boolean;
  error?: string;
}
