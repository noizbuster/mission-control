import { describe, expect, it, vi } from 'vitest';
import {
    type AgentNodeRunBudgetGrantorOptions,
    createAgentNodeRunBudgetGrantor,
    formatBudgetRequestPrompt,
} from './agent-node-run-budget-grantor';

// generate is injected in these tests; model is only required for typing of the generate call.
const stubModelResolver = (() => ({})) as unknown as AgentNodeRunBudgetGrantorOptions['resolveSdkModel'];

describe('createAgentNodeRunBudgetGrantor', () => {
    it('maps APPROVE text from the supervisor agent into a grant', async () => {
        const generate = vi.fn(async () => ({ text: 'APPROVE 30' }));
        const grantor = createAgentNodeRunBudgetGrantor({
            resolveSdkModel: stubModelResolver,
            model: { providerID: 'local', modelID: 'local-echo' },
            generate: generate as never,
        });

        const decision = await grantor({
            graphId: 'default',
            sessionId: 'session_budget',
            used: 100,
            limit: 100,
            proposedGrant: 40,
            extensionsUsed: 0,
            maxExtensions: 2,
            hardCeiling: 180,
            recentNodeIds: ['explore', 'explore', 'draft-plan'],
        });

        expect(decision).toEqual({ granted: true, grant: 30, reason: 'APPROVE 30' });
        expect(generate).toHaveBeenCalledOnce();
    });

    it('fails closed when the supervisor agent throws', async () => {
        const grantor = createAgentNodeRunBudgetGrantor({
            resolveSdkModel: stubModelResolver,
            model: { providerID: 'local', modelID: 'local-echo' },
            generate: (async () => {
                throw new Error('provider down');
            }) as never,
        });

        const decision = await grantor({
            graphId: 'default',
            sessionId: 'session_budget',
            used: 100,
            limit: 100,
            proposedGrant: 40,
            extensionsUsed: 0,
            maxExtensions: 2,
            hardCeiling: 180,
            recentNodeIds: [],
        });

        expect(decision.granted).toBe(false);
        expect(decision.reason).toContain('provider down');
    });
});

describe('formatBudgetRequestPrompt', () => {
    it('includes used/limit and recent nodes for the supervisor agent', () => {
        const prompt = formatBudgetRequestPrompt({
            graphId: 'default',
            sessionId: 'session_budget',
            used: 100,
            limit: 100,
            proposedGrant: 40,
            extensionsUsed: 1,
            maxExtensions: 2,
            hardCeiling: 180,
            recentNodeIds: ['explore', 'draft-plan'],
        });
        expect(prompt).toContain('used: 100');
        expect(prompt).toContain('limit: 100');
        expect(prompt).toContain('explore → draft-plan');
    });
});
