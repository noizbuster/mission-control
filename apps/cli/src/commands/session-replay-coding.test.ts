import { missionControlDataDirEnvKey } from '@mission-control/core';
import { AgentEventSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { runSessionCommand } from './session.js';
import {
    codingStepRecords,
    eventRecords,
    parseReplayRecords,
    providerFromPatchRequests,
} from './session-test-support.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session replay coding projection', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('replays coding runs with provider, tool, result, and continuation records', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-cli-replay-workspace-'));
        const sessionId = 'session_cli_replay_coding';
        const runOutput = await runAgent(
            parseArgs(['run', 'patch then summarize', '--session', sessionId, '--jsonl']),
            {
                workspaceRoot,
                provider: providerFromPatchRequests(),
                nonInteractiveAutomationPolicy: 'test-only-allow-known-safe-patch',
            },
        );
        const runEvents = parseEventLines(runOutput);

        // When
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayRecords = parseReplayRecords(replayOutput);
        const showOutput = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));

        // Then
        const runEventTypes = runEvents.map((event) => event.type);
        const replayEventTypes = eventRecords(replayRecords).map((event) => event.type);
        expect(replayEventTypes).toEqual(expect.arrayContaining(runEventTypes));
        expect(codingStepRecords(replayRecords)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'provider.tool_call', toolCallId: 'session_patch_call' }),
                expect.objectContaining({ kind: 'tool.result', status: 'completed' }),
                expect.objectContaining({
                    kind: 'provider.message',
                    continuation: true,
                    message: 'patch applied after replay',
                }),
            ]),
        );
        expect(showOutput).toMatchObject({
            sessionId,
            toolOutcomes: [
                expect.objectContaining({
                    toolId: 'session_patch_call',
                    status: 'completed',
                }),
            ],
            codingSteps: expect.arrayContaining([
                expect.objectContaining({ kind: 'provider.message', continuation: true }),
            ]),
            diagnostics: [],
        });
        expect(await readFile(join(workspaceRoot, '.mctrl-known-safe-automation-patch.txt'), 'utf8')).toBe(
            'replayed\n',
        );
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

function parseEventLines(output: string) {
    return output
        .trim()
        .split('\n')
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}
