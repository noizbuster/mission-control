import type { ProviderAdapter, ProviderTurnRequest } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
    createEmptyAuthStore,
    createFieldsCredential,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';

describe('runAgent /model chat command', () => {
    it('changes the current chat model with the /model command before later prompts', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('anthropic')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model anthropic/claude-3-5-haiku-20241022' },
                { type: 'line', value: 'explain model routing' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
            createProvider: () => createEchoProvider(),
        });

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('provider: anthropic');
        expect(output).toContain('model: claude-3-5-haiku-20241022');
        expect(output).toContain('selection: anthropic/claude-3-5-haiku-20241022');
        expect(output).toContain('Assistant: received prompt: explain model routing');
        const promptCompleted = events.find(
            (event) => event.type === 'task.completed' && event.message === 'received prompt: explain model routing',
        );
        expect(promptCompleted?.modelProviderSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
    });

    it('changes the current chat model variant with the /model command before later prompts', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('local')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model local/local-echo#fast' },
                { type: 'line', value: 'explain variant routing' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('variant: fast');
        expect(output).toContain('selection: local/local-echo#fast');
        expect(output).toContain('Assistant: received prompt: explain variant routing');
        const promptCompleted = events.find(
            (event) => event.type === 'task.completed' && event.message === 'received prompt: explain variant routing',
        );
        expect(promptCompleted?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'fast',
        });
    });

    it('opens a model picker for /model without arguments', async () => {
        const chatOutput = createBufferedChatOutput();
        const pickerChoices: string[][] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('local')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model' },
                { type: 'line', value: 'after bare picker' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            selectModel: async (choices) => {
                pickerChoices.push(choices.map((choice) => choice.label));
                return choices.find((choice) =>
                    pickerChoices.length === 1
                        ? choice.selection.modelID === 'local-echo'
                        : choice.selection.variantID === 'fast',
                )?.selection;
            },
        });

        expect(pickerChoices).toEqual([
            ['local/local-echo [executable]'],
            expect.arrayContaining(['local/local-echo#fast [executable]']),
        ]);
        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('variant: fast');
        expect(output).toContain('selection: local/local-echo#fast');
        expect(output).toContain('Assistant: received prompt: after bare picker');
    });

    it('suspends the main chat input while the model picker owns stdin', async () => {
        const chatOutput = createBufferedChatOutput();
        const suspendState = { suspendCount: 0, resumeCount: 0, isSuspended: false };
        let selectorSawSuspended = false;
        const scripted = createScriptedChatInput([
            { type: 'line', value: '/model pick' },
            { type: 'line', value: 'after canceled picker' },
            { type: 'interrupt' },
            { type: 'interrupt' },
        ]);

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('local')]),
            chatInput: {
                read: scripted.read,
                close: scripted.close,
                suspend: () => {
                    suspendState.suspendCount += 1;
                    suspendState.isSuspended = true;
                },
                resume: () => {
                    suspendState.resumeCount += 1;
                    suspendState.isSuspended = false;
                },
            },
            chatOutput: chatOutput.output,
            selectModel: async () => {
                selectorSawSuspended = suspendState.isSuspended;
                return undefined;
            },
        });

        expect(suspendState.suspendCount).toBe(1);
        expect(suspendState.resumeCount).toBe(1);
        expect(selectorSawSuspended).toBe(true);
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('Assistant: received prompt: after canceled picker');
    });

    it('does not let the /model picker consume normal chat input after cancellation', async () => {
        const chatOutput = createBufferedChatOutput();
        const scripted = createScriptedChatInput([
            { type: 'line', value: '/model pick' },
            { type: 'line', value: 'after canceled picker' },
            { type: 'interrupt' },
            { type: 'interrupt' },
        ]);

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('local')]),
            chatInput: {
                read: scripted.read,
                close: scripted.close,
            },
            chatOutput: chatOutput.output,
            selectModel: async () => undefined,
        });

        expect(output).toContain('Assistant: received prompt: after canceled picker');
    });

    it('opens a model picker for /model pick', async () => {
        const chatOutput = createBufferedChatOutput();
        let pickerChoices: readonly string[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('anthropic')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model pick' },
                { type: 'line', value: 'after picker' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            selectModel: async (choices) => {
                pickerChoices = choices.map((choice) => choice.label);
                return choices[0]?.selection;
            },
            createProvider: () => createEchoProvider(),
        });

        expect(pickerChoices.length).toBeGreaterThan(0);
        expect(pickerChoices.every((choice) => choice.startsWith('anthropic/'))).toBe(true);
        expect(pickerChoices).not.toContain('local/local-echo');
        expect(output).toContain('provider: anthropic');
        expect(output).toContain('selection: anthropic/');
        expect(output).toContain('Assistant: received prompt: after picker');
    });

    it('rejects /model direct selection for providers that are not logged in', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model anthropic/claude-3-5-haiku-20241022' },
                { type: 'line', value: 'after rejected model' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Provider is not logged in: anthropic');
        expect(output).not.toContain('selection: anthropic/claude-3-5-haiku-20241022');
        const promptCompleted = events.find(
            (event) => event.type === 'task.completed' && event.message === 'received prompt: after rejected model',
        );
        expect(promptCompleted?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('prints only logged-in provider models for /model list', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('anthropic')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model list' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        const modelListOutput = output.slice(output.indexOf('Showing 1-'));
        expect(output).toContain('anthropic/claude-3-5-haiku-20241022');
        expect(modelListOutput).not.toContain('local/local-echo');
        expect(modelListOutput).not.toContain('openai/');
    });

    it('filters logged-in provider models through provider model discovery', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('anthropic')], {
                anthropic: createFieldsCredential('anthropic', 'anthropic_discovery_key'),
            }),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model list' },
                { type: 'line', value: '/model anthropic/claude-opus-4-5' },
                { type: 'line', value: '/model anthropic/claude-3-5-haiku-20241022' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            modelDiscovery: async ({ provider }) =>
                provider.id === 'anthropic' ? ['claude-3-5-haiku-20241022'] : undefined,
        });

        const modelListOutput = output;
        expect(modelListOutput).toContain('anthropic/claude-3-5-haiku-20241022');
        expect(output).toContain('selection: anthropic/claude-3-5-haiku-20241022');
    });

    it('still shows catalog models when discovery returns empty', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('anthropic')], {
                anthropic: createFieldsCredential('anthropic', 'anthropic_discovery_key'),
            }),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model list' },
                { type: 'line', value: '/model anthropic/claude-3-5-haiku-20241022' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            modelDiscovery: async () => [],
        });

        expect(output).toContain('anthropic/claude-3-5-haiku-20241022');
    });
});

function sliceModelListOutput(output: string, marker: string): string {
    const startIndex = output.indexOf(marker);
    if (startIndex === -1) {
        return '';
    }
    const nextPromptIndex = output.indexOf('> ', startIndex);
    return output.slice(startIndex, nextPromptIndex === -1 ? undefined : nextPromptIndex);
}

function createEchoProvider(): ProviderAdapter {
    return {
        async *streamTurn(request) {
            const content = `received prompt: ${lastUserPrompt(request)}`;
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content,
                },
                finishReason: 'stop',
            };
        },
    };
}

function lastUserPrompt(request: ProviderTurnRequest): string {
    return [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}
