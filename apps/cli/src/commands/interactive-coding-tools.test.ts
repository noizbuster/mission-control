import type { ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { type InteractiveToolOptions, preflightInteractiveToolCall } from './interactive-coding-tools.js';
import { createBufferedChatOutput } from './run-agent-chat-test-support.js';

describe('interactive coding tools preflight', () => {
    it('rejects ambiguous file.edit selectors before approval and priming', async () => {
        const output = createBufferedChatOutput();
        const approvalRequests: string[] = [];
        const primedRequests: string[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('file.edit', 'edit_ambiguous', {
                path: 'notes.txt',
                oldText: 'before',
                newText: 'after',
                occurrence: 1,
                replaceAll: false,
            }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    approvalRequests.push(request.id);
                    return { requestId: request.id, status: 'allow', reason: 'unexpected' };
                },
                primeApproval: (requestId) => {
                    primedRequests.push(requestId);
                },
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
            },
        );

        expect(settlement).toBeUndefined();
        expect(approvalRequests).toEqual([]);
        expect(primedRequests).toEqual([]);
        expect(output.getOutput()).toContain('Edit preview for file.edit');
        expect(output.getOutput()).toContain('"replaceAll":false');
        expect(output.getOutput()).not.toContain('--- a/notes.txt');
    });

    it('rejects no-op file.edit before approval and priming', async () => {
        const output = createBufferedChatOutput();
        const approvalRequests: string[] = [];
        const primedRequests: string[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('file.edit', 'edit_noop', {
                path: 'notes.txt',
                oldText: 'same',
                newText: 'same',
            }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    approvalRequests.push(request.id);
                    return { requestId: request.id, status: 'allow', reason: 'unexpected' };
                },
                primeApproval: (requestId) => {
                    primedRequests.push(requestId);
                },
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
            },
        );

        expect(settlement).toBeUndefined();
        expect(approvalRequests).toEqual([]);
        expect(primedRequests).toEqual([]);
        expect(output.getOutput()).toContain('Edit preview for file.edit');
    });

    it('rejects binary file.write before preview approval and priming', async () => {
        const output = createBufferedChatOutput();
        const approvalRequests: string[] = [];
        const primedRequests: string[] = [];

        const settlement = await preflightInteractiveToolCall(
            toolCall('file.write', 'write_binary', {
                path: 'notes.bin',
                content: '\u0000\u0001binary',
            }),
            toolOptions(output.output),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    approvalRequests.push(request.id);
                    return { requestId: request.id, status: 'allow', reason: 'unexpected' };
                },
                primeApproval: (requestId) => {
                    primedRequests.push(requestId);
                },
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
            },
        );

        expect(settlement).toBeUndefined();
        expect(approvalRequests).toEqual([]);
        expect(primedRequests).toEqual([]);
        expect(output.getOutput()).toBe('');
    });
});

function toolOptions(output: InteractiveToolOptions['output']): InteractiveToolOptions {
    const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
    return {
        workspaceRoot: '/workspace',
        sessionId: 'session_interactive_tools',
        modelProviderSelection,
        output,
        emitEvent: () => undefined,
    };
}

function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return {
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input),
    };
}
