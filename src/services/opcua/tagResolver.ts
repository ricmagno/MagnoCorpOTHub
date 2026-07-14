/**
 * The single choke point for OPC UA tag grammar. Nothing else in the codebase
 * may strip the 'opcua:' prefix or guess which connection a tag belongs to.
 *
 * Grammar:  'opcua:' rest
 *   rest = '<idOrAlias>:<nodeId>'  when the segment before the first ':' is a
 *                                  registered connection id (uuid) or alias
 *        = '<nodeId>'              otherwise → LEGACY tag: resolves ONLY when
 *                                  an admin has designated a legacy-default
 *                                  connection; the fallback is OFF by default.
 *
 * Aliases are validated slugs (see isValidAlias) that cannot contain '=',
 * while a serialized nodeId's first segment always does (ns=2;s=..., i=85),
 * so qualified and legacy forms are unambiguous against the set of
 * *registered* connections.
 */

export const OPCUA_TAG_PREFIX = 'opcua:';

export interface TagRegistryView {
    /** Resolve a connection id or alias to a connection id; null if unknown. */
    resolveConnectionRef(idOrAlias: string): string | null;
    /** The admin-designated legacy-default connection id; null = fallback disabled. */
    getLegacyDefaultConnectionId(): string | null;
}

export type ParsedOpcuaTag =
    | { connectionId: string; nodeId: string }
    | { error: 'no-connection-specified'; nodeId: string };

const ALIAS_PATTERN = /^[a-z0-9-]{2,32}$/;

export function isValidAlias(alias: string): boolean {
    return ALIAS_PATTERN.test(alias);
}

export function isOpcuaTag(tag: string): boolean {
    return tag.startsWith(OPCUA_TAG_PREFIX);
}

export function parseOpcuaTag(tag: string, registry: TagRegistryView): ParsedOpcuaTag {
    const rest = tag.startsWith(OPCUA_TAG_PREFIX) ? tag.slice(OPCUA_TAG_PREFIX.length) : tag;

    const sep = rest.indexOf(':');
    if (sep > 0) {
        const candidate = rest.slice(0, sep);
        const connectionId = registry.resolveConnectionRef(candidate);
        if (connectionId) {
            return { connectionId, nodeId: rest.slice(sep + 1) };
        }
    }

    // Unqualified (legacy) tag — resolves only via the explicit opt-in.
    const legacyId = registry.getLegacyDefaultConnectionId();
    if (legacyId) {
        return { connectionId: legacyId, nodeId: rest };
    }
    return { error: 'no-connection-specified', nodeId: rest };
}

/** Always emits the qualified form; use for every newly created tag. */
export function formatOpcuaTag(connectionIdOrAlias: string, nodeId: string): string {
    return `${OPCUA_TAG_PREFIX}${connectionIdOrAlias}:${nodeId}`;
}

export const NO_CONNECTION_MESSAGE =
    'OPC UA tag has no connection qualifier and no legacy default connection is configured';

/** Slugify a connection name into an alias candidate (uniqueness handled by caller). */
export function aliasFromName(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    const padded = slug.length >= 2 ? slug : `c-${slug}`;
    return isValidAlias(padded) ? padded : `conn-${padded}`.slice(0, 32);
}
