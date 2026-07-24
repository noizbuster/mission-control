import type { ProviderAdapter, ProviderTurnRequest } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
    createEmptyAuthStore,
    createFieldsCredential,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import { useIsolatedMissionControlDataDir } from './run-agent-data-dir-test-support';

describe('runAgent /model chat command', () => {
    let cleanupDataDir: (() => Promise<void>) | undefined;

    beforeEach(async () => {
        cleanupDataDir = await useIsolatedMissionControlDataDir('mission-control-model-command-');
    });

    afterEach(async () => {
        await cleanupDataDir?.();
        cleanupDataDir = undefined;
    });

    it('changes the current chat model with the /model command before later prompts', async () => {
        const chatOutput = createBufferedChatOutput();
        let promptModelCall: AgentEvent | undefined;

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
                if (isModelCallCompletedMessage(event, 'received prompt: explain model routing')) {
                    promptModelCall = event;
                }
            },
            createProvider: () => createEchoProvider(),
        });

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('Assistant: received prompt: explain model routing');
        expect(promptModelCall?.modelProviderSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
    });

    it('changes the current chat model variant with the /model command before later prompts', async () => {
        const chatOutput = createBufferedChatOutput();
        let promptModelCall: AgentEvent | undefined;

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
                if (isModelCallCompletedEvent(event)) {
                    promptModelCall = event;
                }
            },
        });

        expect(output).toContain('variant: fast');
        expect(output).toContain('selection: local/local-echo#fast');
        expect(output).toContain('Assistant: received prompt: explain variant routing');
        expect(promptModelCall?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(promptModelCall?.abg?.model?.variantID).toBe('fast');
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
        let promptModelCall: AgentEvent | undefined;

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
                if (isModelCallCompletedEvent(event)) {
                    promptModelCall = event;
                }
            },
        });

        expect(output).toContain('Provider is not logged in: anthropic');
        expect(output).not.toContain('selection: anthropic/claude-3-5-haiku-20241022');
        expect(promptModelCall?.modelProviderSelection).toEqual({
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
        expect(modelListOutput).toContain('anthropic/');
        expect(modelListOutput).toContain('[executable]');
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
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            modelDiscovery: async () => [],
        });

        expect(output).toMatch(/\nanthropic\/\S+ \[executable\]\n/);
    });
});

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

function isModelCallCompletedMessage(event: AgentEvent, message: string): boolean {
    return event.type === 'model.call.completed' && event.message === message;
}

function isModelCallCompletedEvent(event: AgentEvent): boolean {
    return event.type === 'model.call.completed';
}
