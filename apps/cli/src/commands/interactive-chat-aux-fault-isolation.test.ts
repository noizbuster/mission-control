import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetInputHistoryStoreForTests } from './input-history-store';
import { runInteractiveChatSession } from './interactive-chat';
import { createBufferedChatOutput, createScriptedChatInput } from './run-agent-chat-test-support';
import {
    type IsolatedMissionControlTestScope,
    useIsolatedMissionControlTestScope,
} from './run-agent-data-dir-test-support';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

let testScope: IsolatedMissionControlTestScope | undefined;

beforeEach(async () => {
    testScope = await useIsolatedMissionControlTestScope('mctrl-aux-fault-data-');
    resetInputHistoryStoreForTests();
});

afterEach(async () => {
    await testScope?.cleanup();
    testScope = undefined;
});

describe('runInteractiveChatSession auxiliary await fault isolation', () => {
    it('survives an input-history write failure instead of exiting the session', async () => {
        const dataDir = testScope?.dataDir;
        if (dataDir === undefined) throw new Error('expected isolated data directory');
        // A directory at the history file path makes every append reject (EISDIR).
        await mkdir(join(dataDir, 'input-history.json'));
        const chatOutput = createBufferedChatOutput();

        const output = await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput(
                [
                    { type: 'line', value: '/help' },
                    { type: 'line', value: '/exit' },
                ],
                0,
            ),
            output: chatOutput.output,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            provider: createDeterministicProvider([]),
        });

        expect(output).toContain('Could not save input history');
        expect(output).toContain('Exiting mission-control chat');
    });

    it('surfaces an ensureSession failure and keeps the loop alive', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput(
                [
                    { type: 'line', value: 'do a thing' },
                    { type: 'line', value: '/exit' },
                ],
                0,
            ),
            output: chatOutput.output,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            provider: createDeterministicProvider([]),
            ensureSession: async () => {
                throw new Error('session store unavailable');
            },
        });

        expect(output).toContain('could not start a session: session store unavailable');
        expect(output).toContain('Exiting mission-control chat');
    });
});
