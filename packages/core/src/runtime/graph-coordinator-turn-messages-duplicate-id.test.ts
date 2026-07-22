import type { AgentMessage } from '@mission-control/protocol';
import { expect, it } from 'vitest';
import { agentMessagesToSeedModelMessages } from './graph-coordinator-turn-messages';

it('consumes a settled call ID so a malformed duplicate cannot reuse its mapping', () => {
    // Given
    const messages: AgentMessage[] = [
        {
            role: 'assistant',
            content: '',
            providerToolCalls: [
                {
                    providerID: 'openai',
                    toolCallId: 'call_duplicate',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":"README.md"}',
                },
            ],
        },
        { role: 'tool', toolCallId: 'call_duplicate', status: 'completed', output: 'accepted result' },
        {
            role: 'assistant',
            content: '',
            providerToolCalls: [
                {
                    providerID: 'openai',
                    toolCallId: 'call_duplicate',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":',
                },
            ],
        },
        { role: 'tool', toolCallId: 'call_duplicate', status: 'completed', output: 'stale result' },
    ];

    // When
    const result = agentMessagesToSeedModelMessages(messages);

    // Then
    expect(result).toEqual([
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool-call',
                    toolCallId: 'call_duplicate',
                    toolName: 'repo_read',
                    input: { path: 'README.md' },
                },
            ],
        },
        {
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call_duplicate',
                    toolName: 'repo_read',
                    output: { type: 'text', value: 'accepted result' },
                },
            ],
        },
    ]);
});
