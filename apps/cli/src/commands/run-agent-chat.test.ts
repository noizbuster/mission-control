import { missionControlDataDirEnvKey } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive chat', () => {
    const tempDirs: string[] = [];

    beforeEach(async () => {
        const dataDir = await tempRoot('mctrl-run-agent-chat-data-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

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

    it('redacts credentials in the provider response for lazy-materialized sessions', async () => {
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

        // Lazy mode materializes a durable session on the first prompt. The model response
        // (task.completed message) redacts credential patterns in its content.
        const taskCompleted = events.find((event) => event.type === 'task.completed');
        expect(taskCompleted?.message).not.toContain('sk-test-secret-token');
        expect(taskCompleted?.message).toContain('[REDACTED_CREDENTIAL]');
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

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempDirs.push(path);
        return path;
    }
});
