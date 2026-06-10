import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
} from './run-agent-chat-test-support.js';

type SuspendableScriptedChatEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
      };

describe('runAgent /model picker suspension', () => {
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
});

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
