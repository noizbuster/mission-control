import { createDeterministicProvider, openLocalSessionEventStore } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive resume turn-id advancement', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('does not reuse an already-promoted input_turn_interactive id after resuming a durable session', async () => {
        const dataDir = await tempRoot('mctrl-chat-resume-turn-id-');
        const sessionId = 'session_resume_turn_id';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedPriorInteractiveTurn(dataDir, sessionId);

        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [{ type: 'line', value: 'new prompt after resume' }, { type: 'interrupt' }, { type: 'interrupt' }],
                50,
            ),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'response_completed', content: 'new response after resume' },
            ]),
        });

        expect(output).not.toContain('has already been promoted');
        expect(output).toContain('Assistant: new response after resume');

        const replay = await replayEvents(dataDir, sessionId);
        const newPromoted = replay.filter(
            (event) => event.type === 'prompt.promoted' && event.transcript?.inputId === 'input_turn_interactive_1',
        );
        expect(newPromoted).toHaveLength(1);

        const secondPromoted = replay.filter(
            (event) => event.type === 'prompt.promoted' && event.transcript?.inputId !== 'input_turn_interactive_1',
        );
        expect(secondPromoted.length).toBeGreaterThanOrEqual(1);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

const FIXED_NOW = '2026-06-13T00:00:00.000Z';

async function seedPriorInteractiveTurn(dataDir: string, sessionId: string): Promise<void> {
    const store = await openLocalSessionEventStore({
        dataDir,
        sessionId,
        now: () => FIXED_NOW,
        createEventId: (_event, sequence) => `seed_event_${sequence}`,
    });
    try {
        const events: AgentEvent[] = [
            {
                type: 'session.started',
                timestamp: FIXED_NOW,
                sessionId,
                message: 'seed session started',
                nativeSidecarStatus: 'mock',
            },
            {
                type: 'prompt.admitted',
                timestamp: FIXED_NOW,
                sessionId,
                message: 'prior interactive prompt',
                transcript: {
                    inputId: 'input_turn_interactive_1',
                    messageId: 'message_turn_interactive_1',
                    delivery: 'steer',
                    visibility: 'pending',
                },
            },
            {
                type: 'prompt.promoted',
                timestamp: FIXED_NOW,
                sessionId,
                message: 'prior interactive prompt',
                transcript: {
                    inputId: 'input_turn_interactive_1',
                    messageId: 'message_turn_interactive_1',
                    delivery: 'steer',
                    visibility: 'model_visible',
                },
            },
            {
                type: 'run.completed',
                timestamp: FIXED_NOW,
                sessionId,
                message: 'prior run completed',
                run: { command: 'run', state: 'completed', runId: 'run_seed' },
            },
        ];
        for (const event of events) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

async function replayEvents(dataDir: string, sessionId: string): Promise<readonly AgentEvent[]> {
    const store = await openLocalSessionEventStore({
        dataDir,
        sessionId,
        now: () => FIXED_NOW,
        createEventId: (_event, sequence) => `read_event_${sequence}`,
    });
    try {
        return await store.getEvents(sessionId);
    } finally {
        await store.close();
    }
}
