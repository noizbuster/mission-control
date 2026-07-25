import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../memory/in-memory-store';
import { readRunCoordinatorMessages } from './run-coordinator-messages';

const sessionId = 'session_conversation_history';
const timestamp = '2026-07-23T00:00:00.000Z';

describe('readRunCoordinatorMessages', () => {
    it('replays ordinary durable user and assistant history before the next turn', async () => {
        const store = new InMemoryEventStore();
        await store.append({
            type: 'prompt.promoted',
            timestamp,
            sessionId,
            message: 'Inspect the failing test.',
            transcript: {
                inputId: 'input_prior',
                messageId: 'message_prior',
                delivery: 'queue',
            },
        });
        await store.append({
            type: 'model.call.completed',
            timestamp,
            sessionId,
            providerStreamChunk: {
                kind: 'response_completed',
                requestId: 'request_prior',
                sequence: 1,
                message: {
                    messageId: 'assistant_prior',
                    role: 'assistant',
                    content: 'The failure is caused by stale state.',
                },
                finishReason: 'stop',
            },
        });
        await store.append({
            type: 'prompt.promoted',
            timestamp,
            sessionId,
            message: 'Continue with the fix.',
            transcript: {
                inputId: 'input_current',
                messageId: 'message_current',
                delivery: 'queue',
            },
        });

        const messages = await readRunCoordinatorMessages({ sessionId, store });

        expect(messages).toEqual([
            { role: 'user', content: 'Inspect the failing test.' },
            { role: 'assistant', content: 'The failure is caused by stale state.' },
            { role: 'user', content: 'Continue with the fix.' },
        ]);
    });

    it('restores graph tool output into a cold continuation transcript', async () => {
        const store = new InMemoryEventStore();
        await store.append({
            type: 'prompt.promoted',
            timestamp,
            sessionId,
            message: 'Read README.md.',
            transcript: {
                inputId: 'input_prior',
                messageId: 'message_prior',
                delivery: 'queue',
            },
        });
        await store.append({
            type: 'log',
            timestamp,
            sessionId,
            message: 'node emitted event: llm.tool_call.proposed',
            modelProviderSelection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
            abg: {
                graphId: 'graph_coding_agent',
                nodeId: 'llm_actor',
                nodeKind: 'llm',
                signalType: 'emit',
                emit: {
                    type: 'llm.tool_call.proposed',
                    payload: { toolCallId: 'call_readme', toolName: 'file.read', input: { path: 'README.md' } },
                },
            },
        });
        await store.append({
            type: 'tool.completed',
            timestamp,
            sessionId,
            message: 'node emitted event: tool.completed',
            toolResult: { toolCallId: 'call_readme', status: 'completed' },
            abg: {
                graphId: 'graph_coding_agent',
                nodeId: 'llm_actor',
                nodeKind: 'llm',
                signalType: 'emit',
                emit: {
                    type: 'tool.completed',
                    payload: {
                        toolCallId: 'call_readme',
                        toolName: 'file.read',
                        output: '# Mission Control',
                    },
                },
            },
        });
        await store.append({
            type: 'model.call.completed',
            timestamp,
            sessionId,
            message: '',
            abg: {
                graphId: 'graph_coding_agent',
                nodeId: 'llm_actor',
                nodeKind: 'llm',
            },
        });

        const messages = await readRunCoordinatorMessages({ sessionId, store });

        expect(messages).toEqual([
            { role: 'user', content: 'Read README.md.' },
            {
                role: 'assistant',
                content: '',
                providerToolCalls: [
                    {
                        providerID: 'anthropic',
                        toolCallId: 'call_readme',
                        toolName: 'file.read',
                        argumentsJson: '{"path":"README.md"}',
                    },
                ],
            },
            { role: 'tool', toolCallId: 'call_readme', status: 'completed', output: '# Mission Control' },
        ]);
    });
});
