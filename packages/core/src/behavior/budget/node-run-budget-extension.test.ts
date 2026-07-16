import { describe, expect, it } from 'vitest';
import {
    applyNodeRunBudgetGrant,
    hardCeilingForNodeRunBudget,
    parseAgentBudgetDecisionText,
} from './node-run-budget-extension';

describe('hardCeilingForNodeRunBudget', () => {
    it('adds grantSize times maxExtensions to the initial max', () => {
        expect(hardCeilingForNodeRunBudget({ initialMax: 100, grantSize: 40, maxExtensions: 2 })).toBe(180);
    });
});

describe('applyNodeRunBudgetGrant', () => {
    it('applies a positive agent grant under the hard ceiling', () => {
        // Given: agent approves +40 under ceiling 180
        // When: grant is applied at current max 100
        // Then: next max is 140
        expect(
            applyNodeRunBudgetGrant({
                currentMax: 100,
                hardCeiling: 180,
                proposedGrant: 40,
                decision: { granted: true, grant: 40 },
            }),
        ).toEqual({ applied: true, grant: 40, nextMax: 140 });
    });

    it('clamps grant to remaining room under the hard ceiling', () => {
        expect(
            applyNodeRunBudgetGrant({
                currentMax: 170,
                hardCeiling: 180,
                proposedGrant: 40,
                decision: { granted: true, grant: 40 },
            }),
        ).toEqual({ applied: true, grant: 10, nextMax: 180 });
    });

    it('rejects denials and non-positive grants', () => {
        expect(
            applyNodeRunBudgetGrant({
                currentMax: 100,
                hardCeiling: 180,
                proposedGrant: 40,
                decision: { granted: false, reason: 'stuck' },
            }),
        ).toEqual({ applied: false, reason: 'stuck' });
        expect(
            applyNodeRunBudgetGrant({
                currentMax: 100,
                hardCeiling: 180,
                proposedGrant: 40,
                decision: { granted: true, grant: 0 },
            }),
        ).toEqual({ applied: false, reason: 'agent grant was non-positive' });
    });
});

describe('parseAgentBudgetDecisionText', () => {
    it('parses APPROVE with optional grant size', () => {
        expect(parseAgentBudgetDecisionText('APPROVE 25', 40)).toEqual({
            granted: true,
            grant: 25,
            reason: 'APPROVE 25',
        });
        expect(parseAgentBudgetDecisionText('approve', 40)).toEqual({
            granted: true,
            grant: 40,
            reason: 'approve',
        });
    });

    it('parses DENY with optional reason and fails closed on garbage', () => {
        expect(parseAgentBudgetDecisionText('DENY oscillating tools', 40)).toEqual({
            granted: false,
            reason: 'oscillating tools',
        });
        expect(parseAgentBudgetDecisionText('maybe later', 40).granted).toBe(false);
        expect(parseAgentBudgetDecisionText('   ', 40).granted).toBe(false);
    });
});
