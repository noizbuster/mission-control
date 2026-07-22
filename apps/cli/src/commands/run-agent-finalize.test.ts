import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent session finalize line', () => {
    const tempDirs: string[] = [];

    beforeEach(async () => {
        vi.stubEnv(missionControlDataDirEnvKey, await tempRoot('mctrl-finalize-data-'));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('emits "Session complete" after /exit', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([{ type: 'line', value: '/exit' }]),
            chatOutput: chatOutput.output,
        });

        expect(output).toContain('Exiting mission-control chat');
        expect(output).toContain('Session complete');
        expect(output.lastIndexOf('Session complete')).toBeGreaterThan(
            output.lastIndexOf('Exiting mission-control chat'),
        );
    });

    it('emits "Session aborted" after two consecutive Ctrl+C interrupts while idle', async () => {
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

        expect(output).toContain('Session aborted');
        const abortedIndex = output.lastIndexOf('Session aborted');
        const hintIndex = output.lastIndexOf('Press Ctrl+C again to exit');
        expect(abortedIndex).toBeGreaterThan(hintIndex);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempDirs.push(path);
        return path;
    }
});

describe('runAgent session finalize line (JSON mode)', () => {
    const tempDirs: string[] = [];

    beforeEach(async () => {
        vi.stubEnv(missionControlDataDirEnvKey, await tempRoot('mctrl-finalize-json-data-'));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('emits a session.finalize AgentEvent as the final JSON line on stdout', async () => {
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stdoutCapture: string[] = [];
        stdoutSpy.mockImplementation((text) => {
            stdoutCapture.push(typeof text === 'string' ? text : text.toString());
            return true;
        });

        try {
            const output = await runAgent(
                parseArgs([
                    'run',
                    'summarize this repository',
                    '--json',
                    '--provider',
                    'local',
                    '--model',
                    'local-echo',
                ]),
                {
                    authStore: createEmptyAuthStore(),
                },
            );

            const lines = output.trim().split('\n');
            const last = lines.at(-1);
            if (last === undefined) throw new Error('expected at least one JSON line');
            const finalEvent = JSON.parse(last);
            expect(finalEvent.type).toBe('session.finalize');
            expect(finalEvent.sessionFinalize?.status).toBe('complete');
        } finally {
            stdoutSpy.mockRestore();
        }
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempDirs.push(path);
        return path;
    }
});
