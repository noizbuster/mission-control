import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import type { ProviderAuthStore } from '../auth-store.js';
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
        let pickerChoices: readonly string[] = [];

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
                pickerChoices = choices.map((choice) => choice.label);
                return choices.find((choice) => choice.selection.variantID === 'fast')?.selection;
            },
        });

        expect(pickerChoices).toContain('local/local-echo#fast');
        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('variant: fast');
        expect(output).toContain('selection: local/local-echo#fast');
        expect(output).toContain('Assistant: received prompt: after bare picker');
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
        });

        expect(pickerChoices.length).toBeGreaterThan(0);
        expect(pickerChoices.every((choice) => choice.startsWith('anthropic/'))).toBe(true);
        expect(pickerChoices).not.toContain('local/local-echo');
        expect(output).toContain('provider: anthropic');
        expect(output).toContain('selection: anthropic/');
        expect(output).toContain('Assistant: received prompt: after picker');
    });

    it('suspends chat input while the /model picker owns raw keypresses', async () => {
        const chatOutput = createBufferedChatOutput();
        const chatInput = createSuspendableScriptedChatInput([
            { type: 'line', value: '/model' },
            { type: 'line', value: '/exit' },
        ]);
        const selectorSuspendedStates: boolean[] = [];

        await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('local')]),
            chatInput: chatInput.input,
            chatOutput: chatOutput.output,
            selectModel: async () => {
                selectorSuspendedStates.push(chatInput.isSuspended());
                return undefined;
            },
        });

        expect(selectorSuspendedStates).toEqual([true]);
        expect(chatInput.getSuspendCount()).toBe(1);
        expect(chatInput.getResumeCount()).toBe(1);
        expect(chatOutput.getOutput()).toContain('Exiting mission-control chat');
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

        const modelListOutput = sliceModelListOutput(output, 'Showing 1-1 of 1');
        expect(modelListOutput).toContain('anthropic/claude-3-5-haiku-20241022');
        expect(modelListOutput).not.toContain('anthropic/claude-opus-4-5');
        expect(output).toContain('Unknown model: anthropic/claude-opus-4-5');
        expect(output).toContain('selection: anthropic/claude-3-5-haiku-20241022');
    });

    it('reports no available models when discovery filters out every catalog model', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('anthropic')], {
                anthropic: createFieldsCredential('anthropic', 'anthropic_discovery_key'),
            }),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model list' },
                { type: 'line', value: '/model pick' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            modelDiscovery: async () => [],
        });

        expect(output).toContain('No models are available for logged-in providers');
        expect(output).not.toContain('No logged-in providers are available for /model');
    });

    it('does not persist /model changes to the auth store', async () => {
        const chatOutput = createBufferedChatOutput();
        const store = createAuthStoreWithSummaries([createCredentialSummary('anthropic')]);
        let saveCount = 0;
        const trackingStore: ProviderAuthStore = {
            ...store,
            saveCredential: async () => {
                saveCount += 1;
            },
        };

        await runAgent(parseArgs([]), {
            authStore: trackingStore,
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model anthropic/claude-3-5-haiku-20241022' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });
        const laterOutput = await runAgent(parseArgs([]), {
            authStore: trackingStore,
            chatInput: createScriptedChatInput([{ type: 'interrupt' }, { type: 'interrupt' }]),
            chatOutput: createBufferedChatOutput().output,
        });

        expect(saveCount).toBe(0);
        expect(laterOutput).toContain('selection: local/local-echo');
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

type SuspendableScriptedChatEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
      };

function createSuspendableScriptedChatInput(events: readonly SuspendableScriptedChatEvent[]) {
    let index = 0;
    let suspended = false;
    let suspendCount = 0;
    let resumeCount = 0;
    return {
        input: {
            read: async () => {
                const event = events[index] ?? { type: 'interrupt' as const };
                index += 1;
                return event;
            },
            suspend: () => {
                suspended = true;
                suspendCount += 1;
            },
            resume: () => {
                suspended = false;
                resumeCount += 1;
            },
            close: () => {},
        },
        isSuspended: () => suspended,
        getSuspendCount: () => suspendCount,
        getResumeCount: () => resumeCount,
    };
}
