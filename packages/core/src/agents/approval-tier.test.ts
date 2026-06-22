import { describe, expect, it } from 'vitest';
import type { ApprovalMode, ResolveApprovalInput, ToolTier, UserToolPolicy } from './approval-tier.js';
import { APPROVAL_MODE_MAX_TIER, resolveApproval, TIER_RANK } from './approval-tier.js';

const ALL_TIERS: readonly ToolTier[] = ['read', 'write', 'exec'];
const ALL_MODES: readonly ApprovalMode[] = ['always-ask', 'write', 'yolo'];

describe('approval-tier', () => {
    describe('constants', () => {
        it('ranks tiers in ascending order read < write < exec', () => {
            expect(TIER_RANK.read).toBeLessThan(TIER_RANK.write);
            expect(TIER_RANK.write).toBeLessThan(TIER_RANK.exec);
        });

        it('maps every mode to a tier in APPROVAL_MODE_MAX_TIER', () => {
            for (const mode of ALL_MODES) {
                const maxTier = APPROVAL_MODE_MAX_TIER[mode];
                expect(ALL_TIERS).toContain(maxTier);
            }
        });
    });

    describe('resolveApproval — 3x3 tier/mode matrix', () => {
        // (a) always-ask + read → true
        it('requires approval when always-ask mode meets a read tool', () => {
            const result = resolveApproval({ toolTier: 'read', mode: 'always-ask' });
            expect(result.requiresApproval).toBe(true);
            expect(result.reason).toBeTruthy();
        });

        // (b) always-ask + write → true
        it('requires approval when always-ask mode meets a write tool', () => {
            const result = resolveApproval({ toolTier: 'write', mode: 'always-ask' });
            expect(result.requiresApproval).toBe(true);
        });

        // (c) always-ask + exec → true
        it('requires approval when always-ask mode meets an exec tool', () => {
            const result = resolveApproval({ toolTier: 'exec', mode: 'always-ask' });
            expect(result.requiresApproval).toBe(true);
        });

        // (d) write + read → false
        it('does not require approval when write mode meets a read tool', () => {
            const result = resolveApproval({ toolTier: 'read', mode: 'write' });
            expect(result.requiresApproval).toBe(false);
        });

        // (e) write + write → false
        it('does not require approval when write mode meets a write tool', () => {
            const result = resolveApproval({ toolTier: 'write', mode: 'write' });
            expect(result.requiresApproval).toBe(false);
        });

        // (f) write + exec → true
        it('requires approval when write mode meets an exec tool', () => {
            const result = resolveApproval({ toolTier: 'exec', mode: 'write' });
            expect(result.requiresApproval).toBe(true);
        });

        // (g) yolo + read → false
        it('does not require approval when yolo mode meets a read tool', () => {
            const result = resolveApproval({ toolTier: 'read', mode: 'yolo' });
            expect(result.requiresApproval).toBe(false);
        });

        // (h) yolo + write → false
        it('does not require approval when yolo mode meets a write tool', () => {
            const result = resolveApproval({ toolTier: 'write', mode: 'yolo' });
            expect(result.requiresApproval).toBe(false);
        });

        // (i) yolo + exec → false
        it('does not require approval when yolo mode meets an exec tool', () => {
            const result = resolveApproval({ toolTier: 'exec', mode: 'yolo' });
            expect(result.requiresApproval).toBe(false);
        });
    });

    describe('resolveApproval — user policy overrides', () => {
        // (j) yolo + exec + userPolicies[toolName]='prompt' → true
        it('forces approval when user policy is prompt even in yolo mode', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'exec',
                mode: 'yolo',
                toolName: 'bash',
                userPolicies: { bash: 'prompt' },
            };
            const result = resolveApproval(input);
            expect(result.requiresApproval).toBe(true);
        });

        it('forces approval when user policy is deny even in yolo mode', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'exec',
                mode: 'yolo',
                toolName: 'bash',
                userPolicies: { bash: 'deny' as UserToolPolicy },
            };
            const result = resolveApproval(input);
            expect(result.requiresApproval).toBe(true);
        });

        it('defers to mode check when user policy is allow in always-ask mode', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'read',
                mode: 'always-ask',
                toolName: 'read',
                userPolicies: { read: 'allow' },
            };
            const result = resolveApproval(input);
            // 'allow' skips to mode check; always-ask still forces approval.
            expect(result.requiresApproval).toBe(true);
        });

        it('does not require approval when user policy is allow in yolo mode', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'exec',
                mode: 'yolo',
                toolName: 'bash',
                userPolicies: { bash: 'allow' },
            };
            const result = resolveApproval(input);
            expect(result.requiresApproval).toBe(false);
        });

        it('ignores policies for a different tool name', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'exec',
                mode: 'yolo',
                toolName: 'bash',
                userPolicies: { other_tool: 'prompt' },
            };
            const result = resolveApproval(input);
            expect(result.requiresApproval).toBe(false);
        });

        it('falls through to mode check when toolName is omitted but policies exist', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'read',
                mode: 'write',
                userPolicies: { bash: 'prompt' },
            };
            const result = resolveApproval(input);
            expect(result.requiresApproval).toBe(false);
        });

        it('provides a reason referencing the user policy when overriding', () => {
            const input: ResolveApprovalInput = {
                toolTier: 'exec',
                mode: 'yolo',
                toolName: 'file.edit',
                userPolicies: { 'file.edit': 'prompt' },
            };
            const result = resolveApproval(input);
            expect(result.reason).toContain('file.edit');
        });

        it('provides a reason referencing the tier and mode when not overriding', () => {
            const result = resolveApproval({ toolTier: 'exec', mode: 'write' });
            expect(result.reason).toContain('exec');
            expect(result.reason).toContain('write');
        });
    });

    describe('resolveApproval — full matrix sanity', () => {
        // Exhaustive verification of the 3x3 matrix as a regression guard.
        const EXPECTED: Record<ApprovalMode, Record<ToolTier, boolean>> = {
            'always-ask': { read: true, write: true, exec: true },
            write: { read: false, write: false, exec: true },
            yolo: { read: false, write: false, exec: false },
        };

        for (const mode of ALL_MODES) {
            for (const tier of ALL_TIERS) {
                it(`mode=${mode} tier=${tier} requiresApproval=${EXPECTED[mode][tier]}`, () => {
                    const result = resolveApproval({ toolTier: tier, mode });
                    expect(result.requiresApproval).toBe(EXPECTED[mode][tier]);
                });
            }
        }
    });
});
