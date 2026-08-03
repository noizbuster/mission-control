import { describe, expect, it } from 'vitest';
import { resolveRunSessionDebugConfig } from './run-agent-session-debug';

describe('resolveRunSessionDebugConfig', () => {
    it('defaults diagnostics to disabled', () => {
        expect(resolveRunSessionDebugConfig(undefined, undefined).enabled).toBe(false);
    });

    it('honors the explicit flag over the user-profile configuration', () => {
        const configured = { enabled: true, maxBytes: 32 * 1024 * 1024, retentionDays: 7 };

        expect(resolveRunSessionDebugConfig(configured, { enabledOverride: false, argv: [] }).enabled).toBe(false);
        expect(resolveRunSessionDebugConfig(configured, { enabledOverride: true, argv: [] }).enabled).toBe(true);
    });
});
