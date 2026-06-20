import { ProjectTrustStore, type ProviderTurnRequest } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createHelpText } from '../index.js';
import { parseChatLine } from './chat-commands.js';
import {
    captureFailingProvider,
    captureSequentialProvider,
    captureSummaryProvider,
    captureWaitingProvider,
    fixedNow,
    readReplay,
    seedCompactionSession,
    tempRoot,
} from './compact-command-test-support.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('interactive compact command', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('parses compact slash commands with optional focus instructions', () => {
        expect(parseChatLine('/compact')).toEqual({ kind: 'compact' });
        expect(parseChatLine('/compact focus on API changes')).toEqual({
            kind: 'compact',
            instructions: 'focus on API changes',
        });
        expect(parseChatLine('/compact   multiple   spaces  ')).toEqual({
            kind: 'compact',
            instructions: 'multiple   spaces',
        });
        expect(createHelpText()).toContain('/compact');
    });

    it('writes a compaction event through the interactive CLI and renders success output', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-compact-data-');
        const sessionId = 'session_compact_success';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedCompactionSession(dataDir, sessionId);
        const requests: ProviderTurnRequest[] = [];

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/compact' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            provider: captureSummaryProvider(requests, 'summarized session context'),
        });

        expect(output).toContain(`Compacted session ${sessionId}`);
        expect(requests[0]?.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'system',
                    content: expect.stringContaining('Summarize the current session'),
                }),
                expect.objectContaining({ role: 'user', content: 'first task' }),
                expect.objectContaining({ role: 'assistant', content: 'first result' }),
            ]),
        );
        expect(JSON.stringify(requests[0]?.messages)).not.toContain('second task');
        expect(JSON.stringify(requests[0]?.messages)).not.toContain('third result');
        expect((await readReplay(dataDir, sessionId)).projection.sessionTree.compactionBoundaries).toEqual([
            expect.objectContaining({ summary: 'summarized session context' }),
        ]);
    });

    it('threads custom focus instructions into the compaction summary prompt', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-compact-data-');
        const sessionId = 'session_compact_instructions';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedCompactionSession(dataDir, sessionId);
        const requests: ProviderTurnRequest[] = [];

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/compact focus on API changes' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            provider: captureSummaryProvider(requests, 'summarized with api focus'),
        });

        expect(output).toContain(`Compacted session ${sessionId}`);
        expect(requests[0]?.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'system',
                    content: expect.stringContaining('Focus on: focus on API changes'),
                }),
                expect.objectContaining({
                    role: 'system',
                    content: expect.stringContaining('Summarize the current session'),
                }),
            ]),
        );
        expect((await readReplay(dataDir, sessionId)).projection.sessionTree.compactionBoundaries).toEqual([
            expect.objectContaining({ summary: 'summarized with api focus' }),
        ]);
    });

    it('redacts secrets, excludes trusted guidance, and uses compacted future context', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-compact-data-');
        const workspaceRoot = await tempRoot(roots, 'mctrl-compact-workspace-');
        const sessionId = 'session_compact_future_context';
        const secret = 'sk-proj-cliCompactionSecret1234567890';
        const trustedGuidance = 'TRUSTED_COMPACTION_GUIDANCE_SHOULD_NOT_APPEAR';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeFile(join(workspaceRoot, 'AGENTS.md'), trustedGuidance, 'utf8');
        await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await seedCompactionSession(dataDir, sessionId, { firstTask: `first task ${secret}` });
        const requests: ProviderTurnRequest[] = [];

        await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/compact' },
                { type: 'line', value: 'continue after compact' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            workspaceRoot,
            provider: captureSequentialProvider(requests, [
                `Authorization: Bearer ${secret}\napi_key=${secret}\nsummary for pruned history`,
                'continued after compact',
            ]),
        });

        const followUpRequest = requests[1];
        if (followUpRequest === undefined) {
            throw new Error('expected follow-up provider request');
        }
        expect(JSON.stringify(requests[0]?.messages)).not.toContain(trustedGuidance);
        expect(
            JSON.stringify((await readReplay(dataDir, sessionId)).projection.sessionTree.compactionBoundaries),
        ).not.toContain(secret);
        expect(followUpRequest.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'user',
                    content: expect.stringContaining('Session memory summary (untrusted, model-generated):'),
                }),
                expect.objectContaining({ role: 'user', content: 'second task' }),
                expect.objectContaining({ role: 'assistant', content: 'second result' }),
                expect.objectContaining({ role: 'user', content: 'third task' }),
                expect.objectContaining({ role: 'assistant', content: 'third result' }),
                expect.objectContaining({ role: 'user', content: 'continue after compact' }),
            ]),
        );
        expect(JSON.stringify(followUpRequest.messages)).not.toContain('first task');
        expect(
            followUpRequest.messages.some(
                (message) =>
                    message.role === 'system' &&
                    message.content.includes('Session memory summary (untrusted, model-generated):'),
            ),
        ).toBe(false);
    });

    it('reports provider failures without corrupting session state', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-compact-data-');
        const sessionId = 'session_compact_failure';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedCompactionSession(dataDir, sessionId);

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/compact' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            provider: captureFailingProvider(),
        });

        expect(output).toContain('Compaction failed:');
        expect((await readReplay(dataDir, sessionId)).projection.sessionTree.compactionBoundaries).toEqual([]);
    });

    it('supports interruption and leaves session history unchanged', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-compact-data-');
        const sessionId = 'session_compact_interrupt';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedCompactionSession(dataDir, sessionId);

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/compact' },
                { type: 'interrupt' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            provider: captureWaitingProvider(),
        });

        expect(output).toContain('Compaction cancelled');
        expect((await readReplay(dataDir, sessionId)).projection.sessionTree.compactionBoundaries).toEqual([]);
    });
});
