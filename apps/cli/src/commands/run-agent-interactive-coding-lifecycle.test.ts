import { createDeterministicProvider } from '@mission-control/core';
import { type AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import { replayedTypes } from './session-replay-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding agent UX', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('admits queue, steer, resume, branch continue, and interrupts an active provider turn', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_control']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'start a slow provider turn' },
                { type: 'line', value: '/queue follow up after tools' },
                { type: 'line', value: '/steer adjust the current run' },
                { type: 'line', value: '/branch message_parent continue from this branch' },
                { type: 'line', value: '/continue' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toContain('Queued follow-up: follow up after tools');
        expect(output).toContain('Steering current run: adjust the current run');
        expect(output).toContain('Branch continue from message_parent: continue from this branch');
        expect(output).toContain('Resume requested for session_task20_control');
        expect(output).toContain('Interrupted active run');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'prompt.admitted',
                transcript: expect.objectContaining({ delivery: 'queue' }),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'prompt.admitted',
                transcript: expect.objectContaining({
                    delivery: 'steer',
                    parentMessageId: 'message_parent',
                }),
            }),
        );
        const replayTypes = await replayedTypes('session_task20_control');
        expect(replayTypes).toEqual(expect.arrayContaining(['run.interrupted']));
        expect(replayTypes).not.toContain('run.completed');
    });

    it('delivers a queued follow-up as the next drain-lane turn', async () => {
        // Given: read #2 waits for the first turn's real `task.started` runtime
        // event (turn provably active) before admitting '/queue …'; read #3
        // waits for the durable `run.completed` event. No wall-clock races with
        // turn setup, and the interrupt only lands after the queued input ran.
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];
        const firstTurnStarted = Promise.withResolvers<void>();
        const runCompleted = Promise.withResolvers<void>();
        const observe = (event: AgentEvent): void => {
            events.push(event);
            if (event.type === 'task.started') {
                firstTurnStarted.resolve();
            }
            if (event.type === 'run.completed') {
                runCompleted.resolve();
            }
        };
        let reads = 0;
        const chatInput = {
            read: (): Promise<{ readonly type: 'line'; readonly value: string } | { readonly type: 'interrupt' }> => {
                reads += 1;
                if (reads === 1) {
                    return Promise.resolve({ type: 'line', value: 'start a provider turn' });
                }
                if (reads === 2) {
                    return firstTurnStarted.promise.then(
                        () => ({ type: 'line', value: '/queue follow up after the run' }) as const,
                    );
                }
                return runCompleted.promise.then(() => ({ type: 'interrupt' }) as const);
            },
            close: () => {},
        };

        // When: turn 1 spans a 250ms provider wait (real wait — the established
        // deterministic-provider pattern in this integration suite) so the
        // queued admission lands mid-run; the drain lane then promotes the
        // queued input and runs it as the run's second turn.
        const output = await runAgent(parseArgs(['--session', 'session_queue_delivery']), {
            authStore: createEmptyAuthStore(),
            chatInput,
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 250 },
                { kind: 'response_completed', content: 'turn answer' },
            ]),
            onRuntimeEvent: observe,
        });

        // Then: the queued prompt was promoted and ran — two graph executions
        // inside one run, both settled by the single run.completed.
        expect(output).toContain('Queued follow-up: follow up after the run');
        expect(output.match(/final-respond/g)).toHaveLength(2);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'prompt.promoted',
                message: 'follow up after the run',
            }),
        );
        const replayTypes = await replayedTypes('session_queue_delivery');
        expect(replayTypes).toContain('run.completed');
        expect(replayTypes).not.toContain('run.interrupted');
    });

    it('requires two idle Ctrl+C interrupts after stopping an active provider turn', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_interrupt_then_exit']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'start a slow provider turn' },
                { type: 'interrupt' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
        });

        // Then
        expect(output).toContain('Interrupted active run');
        expect(output).toContain('Press Ctrl+C twice to exit');
        expect(output.match(/Press Ctrl\+C again to exit/g)).toHaveLength(1);
        expect(output).not.toContain('too late');
        const replayTypes = await replayedTypes('session_task20_interrupt_then_exit');
        expect(replayTypes).toEqual(expect.arrayContaining(['run.interrupted']));
        expect(replayTypes).not.toContain('run.completed');
    });

    it('exits and force-stops an active provider turn with /exit', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_exit']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'start a child run' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
        });

        // Then
        expect(output).toContain('Interrupted active run');
        expect(output).toContain('Exiting mission-control chat');
        expect(output).not.toContain('too late');
        expect(await replayedTypes('session_task20_exit')).toEqual(expect.arrayContaining(['run.interrupted']));
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});
