import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import { useIsolatedMissionControlDataDir } from './run-agent-data-dir-test-support';

describe('runAgent /model picker input ownership', () => {
    let cleanupDataDir: (() => Promise<void>) | undefined;

    beforeEach(async () => {
        cleanupDataDir = await useIsolatedMissionControlDataDir('mission-control-model-picker-input-');
    });

    afterEach(async () => {
        await cleanupDataDir?.();
        cleanupDataDir = undefined;
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
});
