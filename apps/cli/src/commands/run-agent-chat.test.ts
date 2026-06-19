import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
    setTtyState,
} from './run-agent-chat-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive chat', () => {
    it('opens a prompt for default mctrl execution and exits after two consecutive Ctrl+C interrupts', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'summarize the current mission' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toBe(chatOutput.getOutput());
        expect(output).toContain('mission-control chat');
        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('> ');
        expect(output).toContain('Assistant: received prompt: summarize the current mission');
        expect(output).toContain('Press Ctrl+C again to exit');
        expect(output).not.toContain('demo task started');
        expect(output).not.toContain('completed by mock sidecar');
    });

    it('does not copy raw no-session prompts into emitted fallback task events', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];
        const secretPrompt = 'summarize sk-test-secret-token';

        await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: secretPrompt },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        const taskStarted = events.find((event) => event.type === 'task.started');
        expect(taskStarted?.message).toBe('user prompt submitted');
        expect(events.map((event) => event.message ?? '').join('\n')).not.toContain(secretPrompt);
    });

    it('does not exit when typed input separates Ctrl+C interrupts', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'interrupt' },
                { type: 'interrupt', interruptedPartialInput: true },
                { type: 'line', value: 'continue after interrupted text' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toContain('Assistant: received prompt: continue after interrupted text');
        expect(output.match(/Press Ctrl\+C again to exit/g)).toHaveLength(3);
    });

    it('preserves Ctrl+C after a submitted terminal line as the next interrupt', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'buffered ctrl-c test' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toContain('Assistant: received prompt: buffered ctrl-c test');
        expect(output).toContain('Press Ctrl+C again to exit');
        expect(output.match(/Press Ctrl\+C again to exit/g)).toHaveLength(1);
    });

    it('exits with /exit without submitting a prompt task', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([{ type: 'line', value: '/exit' }]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Exiting mission-control chat');
        expect(events.some((event) => event.type === 'task.started')).toBe(false);
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

    it('uses demo output when stdout is redirected', async () => {
        const restoreTtyState = setTtyState({ input: true, output: false });

        try {
            const output = await runAgent(parseArgs([]));

            expect(output).toContain('completed by mock sidecar');
            expect(output).not.toContain('mission-control chat');
        } finally {
            restoreTtyState();
        }
    });

    it('routes $skill invocations through real skill loading instead of the scaffold recorder', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];
        const emptyWorkspace = await mkdtemp(join(tmpdir(), 'mctrl-skill-chat-'));

        try {
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

            // The scaffold recorder path is gone: no skill.invoke permission gate, no scaffold task.
            expect(output).not.toContain('Skill planner scaffolded');
            expect(
                events.some(
                    (event) => event.type === 'permission.requested' && event.message?.includes('skill.invoke'),
                ),
            ).toBe(false);
            expect(
                events.some(
                    (event) =>
                        event.type === 'task.completed' && event.message?.includes('skill invocation scaffolded'),
                ),
            ).toBe(false);
            // With no discovered `planner` skill, the real loader reports a friendly unknown-skill error.
            expect(output).toContain('Unknown skill: planner');
        } finally {
            await rm(emptyWorkspace, { recursive: true, force: true });
        }
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
});

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
