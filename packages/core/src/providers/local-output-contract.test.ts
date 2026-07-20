import { describe, expect, it } from 'vitest';
import { createDefaultWorkflowGraph } from '../behavior/default-workflow-graph';
import { createFixerWorkflowGraph } from '../behavior/fixer-workflow-graph';
import { createPlannerWorkflowGraph } from '../behavior/planner-workflow-graph';
import { LOCAL_PLANNING_RECOVERY_MESSAGE, localOutputForSystemContract } from './local-output-contract';

const SYSTEM_PROMPT_KEY = 'systemPrompt';

describe('localOutputForSystemContract default + planner recovery', () => {
    it('classifies default intent gate', () => {
        const prompt = systemPromptFrom(createDefaultWorkflowGraph(), 'intent-gate');
        expect(localOutputForSystemContract(prompt, 'hello')).toBe('trivial');
        expect(localOutputForSystemContract(prompt, 'fix the highlight bug')).toBe('explicit-implementation');
        expect(localOutputForSystemContract(prompt, 'explain how auth works')).toBe('exploratory-research');
    });

    it('classifies fixer intent gate the same way', () => {
        const prompt = systemPromptFrom(createFixerWorkflowGraph(), 'intent-gate');
        expect(localOutputForSystemContract(prompt, 'implement a tiny change')).toBe('explicit-implementation');
    });

    it('emits recovery message when planner present-blocked is escalated', () => {
        const blockedPrompt = systemPromptFrom(createPlannerWorkflowGraph(), 'present-blocked');
        const withCorrection = `CORRECTION code=routing_dead_end error=escalated from explore\n\n${blockedPrompt}`;
        expect(localOutputForSystemContract(withCorrection, 'plan this change')).toBe(LOCAL_PLANNING_RECOVERY_MESSAGE);
    });

    it('keeps fixer research-explore completable offline', () => {
        const prompt = systemPromptFrom(createFixerWorkflowGraph(), 'research-explore');
        expect(localOutputForSystemContract(prompt, 'explain the build')).toBe('true');
    });

    it('keeps research-explore completable when a re-admit CORRECTION is prepended', () => {
        const explorePrompt = systemPromptFrom(createFixerWorkflowGraph(), 'research-explore');
        const withCorrection = `CORRECTION code=routing_dead_end error=no outbound edge matched\n\n${explorePrompt}`;
        expect(localOutputForSystemContract(withCorrection, 'ground the plan')).toBe('true');
    });
});

function systemPromptFrom(
    graph: {
        readonly nodes: readonly {
            readonly id: string;
            readonly config?: Record<string, unknown> | undefined;
        }[];
    },
    nodeId: string,
): string {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    const systemPrompt = node?.config?.[SYSTEM_PROMPT_KEY];
    if (typeof systemPrompt !== 'string') {
        throw new TypeError(`expected system prompt for ${nodeId}`);
    }
    return systemPrompt;
}
