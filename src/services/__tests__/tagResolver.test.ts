import fc from 'fast-check';
import {
    TagRegistryView,
    aliasFromName,
    formatOpcuaTag,
    isValidAlias,
    parseOpcuaTag,
} from '../opcua/tagResolver';

const registry = (connections: Record<string, string>, legacyDefault: string | null = null): TagRegistryView => ({
    resolveConnectionRef: (idOrAlias: string) => {
        if (Object.values(connections).includes(idOrAlias)) return idOrAlias;
        return connections[idOrAlias] ?? null;
    },
    getLegacyDefaultConnectionId: () => legacyDefault,
});

describe('tagResolver', () => {
    const reg = registry({ kepserver: 'conn-1', 'plc-line2': 'conn-2' });

    describe('parseOpcuaTag', () => {
        it('resolves alias-qualified tags', () => {
            expect(parseOpcuaTag('opcua:kepserver:ns=2;s=Reactor1.PV', reg)).toEqual({
                connectionId: 'conn-1',
                nodeId: 'ns=2;s=Reactor1.PV',
            });
        });

        it('resolves id-qualified tags', () => {
            expect(parseOpcuaTag('opcua:conn-2:ns=3;i=42', reg)).toEqual({
                connectionId: 'conn-2',
                nodeId: 'ns=3;i=42',
            });
        });

        it('does NOT resolve unqualified tags when no legacy default is designated (off by default)', () => {
            expect(parseOpcuaTag('opcua:ns=2;s=Reactor1.PV', reg)).toEqual({
                error: 'no-connection-specified',
                nodeId: 'ns=2;s=Reactor1.PV',
            });
        });

        it('resolves unqualified tags to the legacy default when one is designated', () => {
            const withDefault = registry({ kepserver: 'conn-1' }, 'conn-1');
            expect(parseOpcuaTag('opcua:ns=2;s=Reactor1.PV', withDefault)).toEqual({
                connectionId: 'conn-1',
                nodeId: 'ns=2;s=Reactor1.PV',
            });
        });

        it('treats an unregistered first segment as part of a legacy nodeId, not an alias', () => {
            // "Channel1" is not a registered alias — dotted KEPServerEX-style
            // node ids must not be misread as connection qualifiers.
            const withDefault = registry({ kepserver: 'conn-1' }, 'conn-1');
            expect(parseOpcuaTag('opcua:Channel1:Device1.Tag1', withDefault)).toEqual({
                connectionId: 'conn-1',
                nodeId: 'Channel1:Device1.Tag1',
            });
        });

        it('nodeIds containing colons survive qualified parsing', () => {
            expect(parseOpcuaTag('opcua:kepserver:ns=2;s=Line:1:Temp', reg)).toEqual({
                connectionId: 'conn-1',
                nodeId: 'ns=2;s=Line:1:Temp',
            });
        });
    });

    describe('round-trip property', () => {
        it('parseOpcuaTag(formatOpcuaTag(alias, nodeId)) round-trips for arbitrary nodeIds', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('kepserver', 'plc-line2'),
                    fc.string({ minLength: 1, maxLength: 80 }),
                    (alias, nodeId) => {
                        const parsed = parseOpcuaTag(formatOpcuaTag(alias, nodeId), reg);
                        expect(parsed).toEqual({
                            connectionId: reg.resolveConnectionRef(alias),
                            nodeId,
                        });
                    }
                )
            );
        });
    });

    describe('isValidAlias', () => {
        it.each(['kepserver', 'plc-line2', 'a1', 'x'.repeat(32)])('accepts %s', (alias) => {
            expect(isValidAlias(alias)).toBe(true);
        });

        it.each(['A', 'has space', 'has_underscore', 'x', '', 'x'.repeat(33), 'ns=2'])('rejects %s', (alias) => {
            expect(isValidAlias(alias)).toBe(false);
        });
    });

    describe('aliasFromName', () => {
        it('slugifies names', () => {
            expect(aliasFromName('Production KEPServerEX #1')).toBe('production-kepserverex-1');
        });

        it('always produces a valid alias', () => {
            fc.assert(
                fc.property(fc.string({ minLength: 1, maxLength: 60 }), (name) => {
                    expect(isValidAlias(aliasFromName(name))).toBe(true);
                })
            );
        });
    });
});
