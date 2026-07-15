import { describe, expect, it } from 'vitest';
import { createDefaultWorkflowGraph } from '../behavior/default-workflow-graph';
import { createLocalCodingProvider } from './local-coding-provider';
import type { ProviderTurnRequest } from './provider-turn-types';

const SYSTEM_PROMPT_KEY = 'systemPrompt';

describe('createLocalCodingProvider structured workflow contracts', () => {
    it('emits the exact trivial token for the default intent gate request', async () => {
        // Given
        const request = requestWithSystem('intent-gate', 'hello');

        // When
        const content = await completedContent(request);

        // Then
        expect(content).toBe('trivial');
    });

    it('emits the exact true token for the safe research completion request', async () => {
        // Given
        const request = requestWithSystem('research-explore', 'explain how the build works');

        // When
        const content = await completedContent(request);

        // Then
        expect(content).toBe('true');
    });

    it('fails the delegation guard closed when the local scaffold cannot perform its checks', async () => {
        // Given
        const request = requestWithSystem('anti-dup-guard', 'implement a tiny change');

        // When
        const content = await completedContent(request);

        // Then
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
