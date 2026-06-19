import type { PermissionRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    CHILD_DROPPED_CAPABILITY_KINDS,
    createChildPermissionRules,
    DESTRUCTIVE_PERMISSION_KINDS,
    isChildSafeCapability,
} from './child-policy.js';

const allow = (permission: PermissionRule['permission'], pattern = '**'): PermissionRule => ({
    permission,
    pattern,
    decision: 'always',
});

describe('createChildPermissionRules (subagent child policy)', () => {
    it('drops destructive allow rules from the parent allow-list', () => {
        const parent = [allow('read'), allow('bash'), allow('write'), allow('patch')];
        const child = createChildPermissionRules({ parentRules: parent });
        const kinds = child.map((rule) => rule.permission);
        expect(kinds).toContain('read');
        expect(kinds).not.toContain('bash');
        expect(kinds).not.toContain('write');
        expect(kinds).not.toContain('patch');
    });

    it('preserves parent deny rules', () => {
        const parent: PermissionRule[] = [allow('read'), { permission: 'bash', pattern: 'rm -rf', decision: 'deny' }];
        const child = createChildPermissionRules({ parentRules: parent });
        const deny = child.find((rule) => rule.decision === 'deny');
        expect(deny?.permission).toBe('bash');
    });

    it('keeps destructive kinds when explicitly escalated', () => {
        const parent = [allow('bash')];
        const child = createChildPermissionRules({ parentRules: parent, escalateKinds: [] });
        expect(child.map((rule) => rule.permission)).toContain('bash');
    });

    it('DESTRUCTIVE_PERMISSION_KINDS is bash/write/patch', () => {
        expect([...DESTRUCTIVE_PERMISSION_KINDS].sort()).toEqual(['bash', 'patch', 'write']);
    });

    it('isChildSafeCapability flags destructive capability sets', () => {
        expect(isChildSafeCapability(['read'])).toBe(true);
        expect(isChildSafeCapability(['bash.run'])).toBe(false);
        expect(isChildSafeCapability(['file.write'])).toBe(false);
    });
});

describe('CHILD_DROPPED_CAPABILITY_KINDS (network/subagent blocklist extension)', () => {
    it('is a strict superset of DESTRUCTIVE_PERMISSION_KINDS', () => {
        for (const kind of DESTRUCTIVE_PERMISSION_KINDS) {
            expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain(kind);
        }
        expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain('network');
        expect(CHILD_DROPPED_CAPABILITY_KINDS).toContain('subagent');
    });

    it('BEFORE-fix characterization: with only the destructive set, a network/subagent capability LEAKS (the bug this extension closes)', () => {
        // Simulate the OLD default by passing the narrow destructive set explicitly.
        expect(isChildSafeCapability(['network'], DESTRUCTIVE_PERMISSION_KINDS)).toBe(true);
        expect(isChildSafeCapability(['subagent'], DESTRUCTIVE_PERMISSION_KINDS)).toBe(true);
    });

    it('AFTER fix: the default blocklist drops network and subagent capability classes', () => {
        // webfetch/mcp tools declare capability class 'network'; the task tool declares 'subagent'.
        expect(isChildSafeCapability(['network'])).toBe(false);
        expect(isChildSafeCapability(['subagent'])).toBe(false);
        // Compound capability sets are blocked if they include a dropped kind.
        expect(isChildSafeCapability(['read', 'network'])).toBe(false);
        expect(isChildSafeCapability(['read', 'subagent'])).toBe(false);
    });

    it('keeps read-class capabilities child-safe under the extended default', () => {
        expect(isChildSafeCapability(['read'])).toBe(true);
        expect(isChildSafeCapability(['read', 'grep'])).toBe(true);
        expect(isChildSafeCapability(['repo.list'])).toBe(true);
    });

    it('never admits a previously-blocked tool (stale-state safety: extending only drops more)', () => {
        // Every capability the narrow set blocked is still blocked by the broad default.
        for (const caps of [['bash'], ['write'], ['patch'], ['bash.run'], ['file.write'], ['file.patch']]) {
            expect(isChildSafeCapability(caps, DESTRUCTIVE_PERMISSION_KINDS)).toBe(false);
            expect(isChildSafeCapability(caps)).toBe(false);
        }
    });
});
