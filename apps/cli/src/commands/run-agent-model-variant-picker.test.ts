import type { ProviderAdapter, ProviderTurnRequest } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { runAgent } from './run-agent.js';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
    createFieldsCredential,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';

describe('runAgent /model provider variant picker', () => {
    it('opens a provider-specific variant picker after model selection', async () => {
        const chatOutput = createBufferedChatOutput();
        const pickerLabels: string[][] = [];
        const pickerTitles: string[] = [];
        const requests: ProviderTurnRequest[] = [];
        const resolvedProviders: string[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('openai')], {
                openai: createFieldsCredential('openai', 'sk-test-secret'),
            }),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model' },
                { type: 'line', value: 'request with reasoning' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            createProvider: (selection) => {
                resolvedProviders.push(formatSelection(selection));
                return providerFromRequests(requests, selection.providerID);
            },
            modelDiscovery: async () => undefined,
            selectModel: async (choices, _currentSelection, options) => {
                pickerLabels.push(choices.map((choice) => choice.label));
                pickerTitles.push(options?.title ?? '');
                if (pickerLabels.length === 1) {
                    return requiredChoice(choices, 'openai/gpt-5').selection;
                }
                return requiredChoice(choices, 'openai/gpt-5#reasoning-high').selection;
            },
        });

        expect(pickerLabels).toHaveLength(2);
        expect(pickerTitles).toEqual(['Select model', 'Select variant']);
        expect(pickerLabels[0]).toContain('openai/gpt-5');
        expect(pickerLabels[0]).not.toContain('openai/gpt-5#reasoning-high');
        expect(pickerLabels[1]).toContain('openai/gpt-5#reasoning-high');
        expect(output).toContain('selection: openai/gpt-5#reasoning-high');
        expect(output).toContain('openai adapter handled openai/gpt-5#reasoning-high');
        expect(resolvedProviders).toContain('local/local-echo');
        expect(resolvedProviders.at(-1)).toBe('openai/gpt-5#reasoning-high');
        expect(requests[0]).toMatchObject({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
        });
    });

    it('selects models without variants directly', async () => {
        const chatOutput = createBufferedChatOutput();
        const pickerLabels: string[][] = [];

        const output = await runAgent(parseArgs(['--model', 'openai/gpt-4o-mini']), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('openai')], {
                openai: createFieldsCredential('openai', 'sk-test-secret'),
            }),
            chatInput: createScriptedChatInput([{ type: 'line', value: '/model' }, { type: 'line', value: '/exit' }]),
            chatOutput: chatOutput.output,
            modelDiscovery: async () => undefined,
            selectModel: async (choices) => {
                pickerLabels.push(choices.map((choice) => choice.label));
                return requiredChoice(choices, 'openai/gpt-4o-mini').selection;
            },
        });

        expect(pickerLabels).toHaveLength(1);
        expect(output).toContain('selection: openai/gpt-4o-mini');
        expect(output).not.toContain('variant:');
        expect(output).not.toContain('Select variant');
    });

    it('rejects unknown provider-specific variants without changing the selection', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('openai')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model openai/gpt-5#not-real' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            modelDiscovery: async () => undefined,
        });

        expect(output).toContain('Variant not-real is not available for model openai/gpt-5');
        expect(output).toContain('selection: local/local-echo');
        expect(output).not.toContain('selection: openai/gpt-5#not-real');
    });

    it('keeps direct provider model variant syntax working', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('local')]),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model local/local-echo#fast' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toContain('selection: local/local-echo#fast');
    });
});

function requiredChoice(choices: readonly ModelChoice[], label: string): ModelChoice {
    const choice = choices.find((candidate) => candidate.label === label);
    if (choice === undefined) {
        throw new Error(`Expected model choice ${label}`);
    }
    return choice;
}

function providerFromRequests(requests: ProviderTurnRequest[], adapterID = 'test'): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: `${adapterID} adapter handled ${formatSelection(request)}`,
                },
                finishReason: 'stop',
            };
        },
    };
}

function formatSelection(selection: ModelProviderSelection): string {
    return `${selection.providerID}/${selection.modelID}${selection.variantID === undefined ? '' : `#${selection.variantID}`}`;
}
