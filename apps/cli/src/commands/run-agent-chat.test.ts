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

describe('runAgent interactive chat', () => {
    it('opens a prompt for default mctrl execution and exits after two Ctrl+C interrupts', async () => {
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
        expect(output).toContain('You: ');
        expect(output).toContain('Assistant: received prompt: summarize the current mission');
        expect(output).toContain('Press Ctrl+C again to exit');
        expect(output).not.toContain('demo task started');
        expect(output).not.toContain('completed by mock sidecar');
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

    it('routes $ skill invocations through scaffold skill tasks with the selected skill name', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
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

        expect(output).toContain('Skill planner scaffolded: draft a rollout checklist');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'permission.requested',
                message: 'permission requested: skill.invoke',
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'task.completed',
                message: 'skill invocation scaffolded: planner',
            }),
        );
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
