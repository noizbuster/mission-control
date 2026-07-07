import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
    setTtyState,
} from './run-agent-chat-test-support.js';
import {
    type IsolatedMissionControlTestScope,
    useIsolatedMissionControlTestScope,
} from './run-agent-data-dir-test-support.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

describe('runAgent interactive chat controls', () => {
    let testScope: IsolatedMissionControlTestScope | undefined;

    beforeEach(async () => {
        testScope = await useIsolatedMissionControlTestScope('mctrl-run-agent-chat-data-');
    });

    afterEach(async () => {
        await testScope?.cleanup();
        testScope = undefined;
    });

    it('closes chat input when a process SIGINT interrupts the terminal', async () => {
        const chatOutput = createBufferedChatOutput();
        const chatInput = createClosablePendingChatInput();
        const run = runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: chatInput.input,
            chatOutput: chatOutput.output,
        });

        await waitForReadToStart(chatInput);
        process.emit('SIGINT');

        const result = await promiseWithTimeout(run, 80);
        if (result.type === 'timeout') {
            chatInput.close();
            await run;
        }

        expect(result.type).toBe('resolved');
        expect(chatInput.getCloseCount()).toBeGreaterThanOrEqual(1);
    });

    it('streams noninteractive output when stdout is redirected', async () => {
        const restoreTtyState = setTtyState({ input: true, output: false });

        try {
            const { result, stdout } = await captureStdout(() =>
                runAgent(parseArgs([]), { authStore: createEmptyAuthStore() }),
            );

            expect(result).toBe('');
            expect(stdout).toContain('> local · local-echo');
            expect(stdout).not.toContain('mission-control chat');
        } finally {
            restoreTtyState();
        }
    });

    it('routes $skill invocations through real skill loading instead of the scaffold recorder', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];
        const emptyWorkspace = await tempRoot('mctrl-skill-chat-');

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            workspaceRoot: emptyWorkspace,
            chatInput: createScriptedChatInput([
                { type: 'line', value: '$planner draft a rollout checklist' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).not.toContain('Skill planner scaffolded');
        expect(
            events.some((event) => event.type === 'permission.requested' && event.message?.includes('skill.invoke')),
        ).toBe(false);
        expect(
            events.some(
                (event) => event.type === 'task.completed' && event.message?.includes('skill invocation scaffolded'),
            ),
        ).toBe(false);
        expect(output).toContain('Unknown skill: planner');
    });

    it('reports unknown slash commands without submitting a prompt task', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/unknown please run this' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Unknown command: /unknown');
        expect(events.some((event) => event.type === 'task.started')).toBe(false);
    });

    it('reports empty slash commands without submitting a prompt task', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/   ' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Slash command is empty');
        expect(events.some((event) => event.type === 'task.started')).toBe(false);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const activeScope = testScope;
        if (activeScope === undefined) {
            throw new Error('test scope was not initialized');
        }
        const path = join(activeScope.dataDir, prefix);
        await mkdir(path, { recursive: true });
        return path;
    }
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ readonly result: T; readonly stdout: string }> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
        writes.push(typeof data === 'string' ? data : String(data));
        return true;
    });
    try {
        const result = await fn();
        return { result, stdout: writes.join('') };
    } finally {
        spy.mockRestore();
    }
}

function createClosablePendingChatInput() {
    let closed = false;
    let closeCount = 0;
    let readStarted: (() => void) | undefined;
    let resolvePendingRead: ((event: { readonly type: 'interrupt' }) => void) | undefined;
    const readStartedPromise = new Promise<void>((resolve) => {
        readStarted = resolve;
    });
    return {
        input: {
            read: async () => {
                if (closed) {
                    return { type: 'interrupt' as const };
                }
                readStarted?.();
                return new Promise<{ readonly type: 'interrupt' }>((resolve) => {
                    resolvePendingRead = resolve;
                });
            },
            close: () => {
                closeCount += 1;
                closed = true;
                resolvePendingRead?.({ type: 'interrupt' });
            },
        },
        close: () => {
            closeCount += 1;
            closed = true;
            resolvePendingRead?.({ type: 'interrupt' });
        },
        getCloseCount: () => closeCount,
        readStarted: () => readStartedPromise,
    };
}

async function waitForReadToStart(input: ReturnType<typeof createClosablePendingChatInput>): Promise<void> {
    await input.readStarted();
}

async function promiseWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<{ readonly type: 'resolved'; readonly value: T } | { readonly type: 'timeout' }> {
    return Promise.race([
        promise.then((value) => ({ type: 'resolved' as const, value })),
        new Promise<{ readonly type: 'timeout' }>((resolve) => {
            setTimeout(() => {
                resolve({ type: 'timeout' });
            }, timeoutMs);
        }),
    ]);
}
