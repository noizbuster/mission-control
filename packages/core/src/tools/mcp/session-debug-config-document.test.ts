import { SessionDebugConfigSchema } from '@mission-control/protocol';
import {
    detachSessionDebugConfig,
    parseSessionDebugConfigDocument,
    serializeConfigPreservingSessionDebug,
    serializeConfigWithSessionDebug,
} from './session-debug-config-document';
import { describe, expect, it } from 'vitest';

describe('session debug config documents', () => {
    it('defaults absent diagnostics and detaches the isolated member', () => {
        const document = parseSessionDebugConfigDocument('{"mcp": {}}');
        expect(document.config).toEqual(SessionDebugConfigSchema.parse({}));
        expect(document.sourceMembers).toEqual([]);
        expect(detachSessionDebugConfig({ mcp: {}, session_debug: { enabled: true } })).toEqual({ mcp: {} });
    });

    it('parses a single JSONC member without accepting unknown fields', () => {
        const document = parseSessionDebugConfigDocument(`{
  "session_debug": {
    // persist only redacted events
    "enabled": true,
    "maxBytes": 33554432,
    "retentionDays": 7
  },
  "mcp": {}
}`);
        expect(document.config).toEqual({ enabled: true, maxBytes: 33_554_432, retentionDays: 7 });
        expect(document.error).toBeUndefined();
        expect(document.sourceMembers).toHaveLength(1);
    });

    it('fails closed on duplicate or malformed diagnostic members', () => {
        const duplicate = parseSessionDebugConfigDocument(`{
  "session_debug": { "enabled": true },
  "session_debug": { "enabled": true }
}`);
        expect(duplicate.config.enabled).toBe(false);
        expect(duplicate.sourceMembers).toHaveLength(2);
        expect(duplicate.error).toContain('duplicate');

        const malformed = parseSessionDebugConfigDocument('{"session_debug": {"enabled": "yes"}}');
        expect(malformed.config.enabled).toBe(false);
        expect(malformed.error).toContain('invalid');
    });

    it('preserves untouched raw debug members and canonicalizes explicit edits', () => {
        const source = `{
  /* preserve this comment */ "session_debug": { "enabled": true }, // and this one
  "session_debug": { "enabled": false },
  "mcp": {}
}`;
        const document = parseSessionDebugConfigDocument(source);
        const preserved = serializeConfigPreservingSessionDebug({ mcp: { test: { type: 'local', command: ['bin'] } } }, document.sourceMembers);
        for (const member of document.sourceMembers) {
            expect(preserved).toContain(member.source);
        }
        expect(preserved).toContain('/* preserve this comment */');
        expect(preserved).toContain('// and this one');

        const canonical = serializeConfigWithSessionDebug(
            { mcp: {} },
            { enabled: true, maxBytes: 33_554_432, retentionDays: 7 },
        );
        expect(canonical.match(/"session_debug"/g)).toHaveLength(1);
        expect(canonical).toContain('"retentionDays": 7');
    });
});
