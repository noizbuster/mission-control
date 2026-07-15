import { describe, expect, it } from 'vitest';
import { CHILD_DROPPED_CAPABILITY_KINDS, DESTRUCTIVE_PERMISSION_KINDS, isChildSafeCapability } from './child-policy.js';

describe('CHILD_DROPPED_CAPABILITY_KINDS (network/subagent/workflow blocklist extension)', () => {
    it('keeps the compatibility destructive set at bash/write/patch', () => {
        expect([...DESTRUCTIVE_PERMISSION_KINDS].sort()).toEqual(['bash', 'patch', 'write']);
    });

    it('is a strict superset of DESTRUCTIVE_PERMISSION_KINDS', () => {
        for (const kind of DESTRUCTIVE_PERMISSION_KINDS) {
            expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain(kind);
        }
        expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain('network');
        expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain('subagent');
        expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain('workflow');
        expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain('team');
    });

    it('BEFORE-fix characterization: with only the destructive set, a network/subagent capability LEAKS (the bug this extension closes)', () => {
        // Simulate the OLD default by passing the narrow destructive set explicitly.
        expect(isChildSafeCapability(['network'], DESTRUCTIVE_PERMISSION_KINDS)).toBe(true);
        expect(isChildSafeCapability(['subagent'], DESTRUCTIVE_PERMISSION_KINDS)).toBe(true);
    });

    it('AFTER fix: the default blocklist drops network, subagent, and workflow capability classes', () => {
        // webfetch/mcp tools declare capability class 'network'; the task tool declares 'subagent';
        // the workflow tool declares capability class 'workflow' — dropped to prevent child recursion.
        expect(isChildSafeCapability(['network'])).toBe(false);
        expect(isChildSafeCapability(['subagent'])).toBe(false);
        expect(isChildSafeCapability(['workflow'])).toBe(false);
        expect(isChildSafeCapability(['team'])).toBe(false);
        // Compound capability sets are blocked if they include a dropped kind.
        expect(isChildSafeCapability(['read', 'network'])).toBe(false);
        expect(isChildSafeCapability(['read', 'subagent'])).toBe(false);
        expect(isChildSafeCapability(['read', 'workflow'])).toBe(false);
    });

    it('keeps read-class capabilities child-safe under the extended default', () => {
        expect(isChildSafeCapability(['read'])).toBe(true);
        expect(isChildSafeCapability(['read', 'grep'])).toBe(true);
        expect(isChildSafeCapability(['repo.list'])).toBe(true);
        expect(isChildSafeCapability(['network-cache'])).toBe(true);
    });

    it('uses exact production capability identifiers for destructive tools', () => {
        expect(isChildSafeCapability(['bash.run'])).toBe(false);
        expect(isChildSafeCapability(['command.run'])).toBe(false);
        expect(isChildSafeCapability(['file.edit'])).toBe(false);
        expect(isChildSafeCapability(['file.write'])).toBe(false);
        expect(isChildSafeCapability(['file.patch'])).toBe(false);
        expect(isChildSafeCapability(['custom.file.write.cache'])).toBe(true);
    });

    it('never admits a previously-blocked tool (stale-state safety: extending only drops more)', () => {
        // Every capability the narrow set blocked is still blocked by the broad default.
        for (const caps of [['bash'], ['write'], ['patch'], ['bash.run'], ['file.write'], ['file.patch']]) {
            expect(isChildSafeCapability(caps, DESTRUCTIVE_PERMISSION_KINDS)).toBe(false);
            expect(isChildSafeCapability(caps)).toBe(false);
        }
    });
});
