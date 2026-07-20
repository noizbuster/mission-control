import { describe, expect, it } from 'vitest';
import { createDefaultWorkflowGraph } from '../behavior/default-workflow-graph';
import { createFixerWorkflowGraph } from '../behavior/fixer-workflow-graph';
import { createPlannerWorkflowGraph } from '../behavior/planner-workflow-graph';
import { createLocalCodingProvider } from './local-coding-provider';
import type { ProviderTurnRequest } from './provider-turn-types';

const SYSTEM_PROMPT_KEY = 'systemPrompt';

describe('createLocalCodingProvider structured workflow contracts', () => {
    it('emits trivial for the default intent gate on a greeting', async () => {
        const request = requestWithGraph(createDefaultWorkflowGraph(), 'intent-gate', 'hello');
        const content = await completedContent(request);
        expect(content).toBe('trivial');
    });

    it('emits explicit-implementation for a fix request at the default intent gate', async () => {
        const request = requestWithGraph(
            createDefaultWorkflowGraph(),
            'intent-gate',
            'fix the highlight on the select overlay',
        );
        const content = await completedContent(request);
        expect(content).toBe('explicit-implementation');
    });

    it('emits true for the fixer research completion gate', async () => {
        const request = requestWithGraph(createFixerWorkflowGraph(), 'research-explore', 'explain how the build works');
        const content = await completedContent(request);
        expect(content).toBe('true');
    });

    it('fails the delegation guard closed offline', async () => {
        const request = requestWithGraph(createFixerWorkflowGraph(), 'anti-dup-guard', 'implement a tiny change');
        const content = await completedContent(request);
        expect(content).toBe('false');
    });

    it('keeps planner approval closed without an explicit user decision', async () => {
        const request = requestWithGraph(createPlannerWorkflowGraph(), 'approval-gate', 'explain how the build works');
        const content = await completedContent(request);
        expect(content).toBe('false');
    });
});

function requestWithGraph(
    graph: { nodes: readonly { id: string; config?: Record<string, unknown> }[] },
    nodeId: string,
    userPrompt: string,
): ProviderTurnRequest {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    const systemPrompt = node?.config?.[SYSTEM_PROMPT_KEY];
    if (typeof systemPrompt !== 'string') {
        throw new TypeError(`expected system prompt for ${nodeId}`);
    }
    return {
        requestId: `request_${nodeId}`,
        sessionId: 'session_local_contract',
        turnId: `turn_${nodeId}`,
        providerID: 'local',
        modelID: 'local-echo',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    };
}

async function completedContent(request: ProviderTurnRequest): Promise<string | undefined> {
    const provider = createLocalCodingProvider();
    for await (const chunk of provider.streamTurn(request, {
        attempt: 1,
        signal: new AbortController().signal,
    })) {
        if (chunk.kind === 'response_completed') {
            return chunk.message.content;
        }
    }
    return undefined;
}
