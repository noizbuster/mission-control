import type { AgentMessage } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { agentMessagesToSeedModelMessages } from './graph-coordinator-turn-messages';

describe('agentMessagesToSeedModelMessages', () => {
    it('preserves cold history ordering and string assistant content when no tool calls exist', () => {
        // Given
        const messages: AgentMessage[] = [
            { role: 'system', content: 'system context' },
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'resumed prompt' },
        ];

        // When
        const result = agentMessagesToSeedModelMessages(messages);

        // Then
        expect(result).toEqual([
            { role: 'system', content: 'system context' },
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'resumed prompt' },
        ]);
    });

    it('emits assistant text and every stored tool call before their matching results', () => {
        // Given
        const messages: AgentMessage[] = [
            { role: 'user', content: 'inspect the workspace' },
            {
                role: 'assistant',
                content: 'I will inspect both files.',
                providerToolCalls: [
                    {
                        providerID: 'anthropic',
                        toolCallId: 'call_read',
                        toolName: 'repo_read',
                        argumentsJson: '{"path":"README.md"}',
                    },
                    {
                        providerID: 'anthropic',
                        toolCallId: 'call_search',
                        toolName: 'repo_search',
                        argumentsJson: '{"query":"TODO","paths":["src","tests"]}',
                    },
                ],
            },
            { role: 'tool', toolCallId: 'call_read', status: 'completed', output: 'README contents' },
            {
                role: 'tool',
                toolCallId: 'call_search',
                status: 'failed',
                error: { code: 'tool_failed', message: 'search failed', retryable: false },
            },
        ];

        // When
        const result = agentMessagesToSeedModelMessages(messages);

        // Then
        expect(result).toEqual([
            { role: 'user', content: 'inspect the workspace' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'I will inspect both files.' },
                    {
                        type: 'tool-call',
                        toolCallId: 'call_read',
                        toolName: 'repo_read',
                        input: { path: 'README.md' },
                    },
                    {
                        type: 'tool-call',
                        toolCallId: 'call_search',
                        toolName: 'repo_search',
                        input: { query: 'TODO', paths: ['src', 'tests'] },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_read',
                        toolName: 'repo_read',
                        output: { type: 'text', value: 'README contents' },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_search',
                        toolName: 'repo_search',
                        output: { type: 'error-text', value: 'search failed' },
                    },
                ],
            },
        ]);
    });

    it('emits a tool-call-only assistant when projected graph history has synthetic empty text', () => {
        // Given
        const messages: AgentMessage[] = [
            {
                role: 'assistant',
                content: '',
                providerToolCalls: [
                    {
                        providerID: 'openai',
                        toolCallId: 'call_patch',
                        toolName: 'file_patch',
                        argumentsJson: '{"patch":"*** Begin Patch"}',
                    },
                ],
            },
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
                        toolCallId: 'call_patch',
                        toolName: 'file_patch',
                        input: { patch: '*** Begin Patch' },
                    },
                ],
            },
        ]);
    });

    it('omits a malformed persisted tool call and its matching result without dropping assistant text', () => {
        // Given
        const messages: AgentMessage[] = [
            {
                role: 'assistant',
                content: 'The persisted call was invalid.',
                providerToolCalls: [
                    {
                        providerID: 'openai',
                        toolCallId: 'call_malformed',
                        toolName: 'repo_read',
                        argumentsJson: '{"path":',
                    },
                ],
            },
            { role: 'tool', toolCallId: 'call_malformed', status: 'completed', output: 'must be omitted' },
        ];

        // When
        const result = agentMessagesToSeedModelMessages(messages);

        // Then
        expect(result).toEqual([{ role: 'assistant', content: 'The persisted call was invalid.' }]);
    });

    it('omits a result that precedes its assistant call while preserving the later outstanding call', () => {
        // Given
        const messages: AgentMessage[] = [
            { role: 'tool', toolCallId: 'call_future', status: 'completed', output: 'premature result' },
            {
                role: 'assistant',
                content: '',
                providerToolCalls: [
                    {
                        providerID: 'anthropic',
                        toolCallId: 'call_future',
                        toolName: 'repo_search',
                        argumentsJson: '{"query":"resume"}',
                    },
                ],
            },
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
                        toolCallId: 'call_future',
                        toolName: 'repo_search',
                        input: { query: 'resume' },
                    },
                ],
            },
        ]);
    });

    it('omits an orphan tool result whose assistant tool call is absent', () => {
        // Given
        const messages: AgentMessage[] = [
            { role: 'user', content: 'resume' },
            { role: 'tool', toolCallId: 'call_orphan', status: 'completed', output: 'orphaned output' },
        ];

        // When
        const result = agentMessagesToSeedModelMessages(messages);

        // Then
        expect(result).toEqual([{ role: 'user', content: 'resume' }]);
    });

    it('keeps a compaction summary before the retained assistant tool exchange', () => {
        // Given
        const messages: AgentMessage[] = [
            { role: 'user', content: 'Session memory summary: prior work' },
            {
                role: 'assistant',
                content: '',
                providerToolCalls: [
                    {
                        providerID: 'google',
                        toolCallId: 'call_retained',
                        toolName: 'repo_read',
                        argumentsJson: '{"path":"src/index.ts"}',
                    },
                ],
            },
            { role: 'tool', toolCallId: 'call_retained', status: 'completed', output: 'retained contents' },
        ];

        // When
        const result = agentMessagesToSeedModelMessages(messages);

        // Then
        expect(result).toEqual([
            { role: 'user', content: 'Session memory summary: prior work' },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'call_retained',
                        toolName: 'repo_read',
                        input: { path: 'src/index.ts' },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'call_retained',
                        toolName: 'repo_read',
                        output: { type: 'text', value: 'retained contents' },
                    },
                ],
            },
        ]);
    });
});
