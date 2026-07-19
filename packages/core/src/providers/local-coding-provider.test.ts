import { describe, expect, it } from 'vitest';
import { createDefaultWorkflowGraph } from '../behavior/default-workflow-graph';
import { createLocalCodingProvider } from './local-coding-provider';
import type { ProviderTurnRequest } from './provider-turn-types';

const SYSTEM_PROMPT_KEY = 'systemPrompt';

describe('createLocalCodingProvider structured workflow contracts', () => {
    it('emits true for the plan-first intake request', async () => {
        // Given
        const request = requestWithSystem('intake', 'hello');

        // When
        const content = await completedContent(request);

        // Then
        expect(content).toBe('true');
    });

    it('emits clear for a well-specified planning request at the ambiguity gate', async () => {
        // Given
        const request = requestWithSystem('assess-ambiguity', 'add rate limiting to the login endpoint');

        // When
        const content = await completedContent(request);

        // Then
        expect(content).toBe('clear');
    });

    it('routes local plan-first prompts through the bounded exploration gate', async () => {
        const request = requestWithSystem('explore-filter', 'hello');

        const content = await completedContent(request);

        expect(content).toBe('needs-exploration');
    });

    it('emits false for the plan-first explore completion gate', async () => {
        // Given
        const request = requestWithSystem('explore', 'ground the plan in the codebase');

        // When
        const content = await completedContent(request);

        // Then
        expect(content).toBe('false');
    });

    it('keeps plan approval closed without an explicit user decision', async () => {
        const request = requestWithSystem('approval-gate', 'explain how the build works');

        const content = await completedContent(request);

        expect(content).toBe('false');
    });
});

function requestWithSystem(nodeId: string, userPrompt: string): ProviderTurnRequest {
    const node = createDefaultWorkflowGraph().nodes.find((candidate) => candidate.id === nodeId);
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
