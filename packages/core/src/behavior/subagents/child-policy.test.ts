import type { PermissionRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createChildPermissionRules, DESTRUCTIVE_PERMISSION_KINDS, isChildSafeCapability } from './child-policy.js';

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
