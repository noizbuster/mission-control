import { missionControlDataDirEnvKey, type ProviderAdapter, type ProviderTurnRequest } from '@mission-control/core';
import { type AgentEvent, AgentEventSchema, type ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { runSessionCommand } from './session.js';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session commands', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists shows and replays JSONL session logs deterministically', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_commands';
        const runOutput = await runAgent(parseArgs(['run', 'hello from session', '--session', sessionId, '--jsonl']));
        const runEvents = parseEventLines(runOutput);

        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));
        const showOutput = await runSessionCommand(parseArgs(['session', 'show', sessionId]));
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayEvents = eventRecords(parseReplayRecords(replayOutput));

        expect(listOutput.trim().split('\n')).toContain(sessionId);
        expect(JSON.parse(showOutput)).toMatchObject({
            sessionId,
            eventCount: runEvents.length,
            snapshot: {
                sessionId,
                status: 'stopped',
            },
        });
        expect(replayEvents.map((event) => event.type)).toEqual(runEvents.map((event) => event.type));
        await rm(dataDir, { recursive: true, force: true });
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
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual(runEvents.map((event) => event.type));
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
        expect(await readFile(join(workspaceRoot, '.mctrl-session-replay.txt'), 'utf8')).toBe('replayed\n');
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('emits replay diagnostics for corrupt trailing JSONL without crashing', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_replay_corrupt';
        const runOutput = await runAgent(
            parseArgs(['run', 'hello before corruption', '--session', sessionId, '--jsonl']),
        );
        const runEvents = parseEventLines(runOutput);
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"broken":\n', 'utf8');

        // When
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayRecords = parseReplayRecords(replayOutput);

        // Then
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual(runEvents.map((event) => event.type));
        expect(diagnosticRecords(replayRecords)).toEqual([
            {
                code: 'corrupt_trailing_record',
                lineNumber: runEvents.length + 2,
                sessionId,
            },
        ]);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('throws typed errors for invalid session ids and missing logs', async () => {
        const dataDir = await useTempDataDir();

        await expect(runSessionCommand(parseArgs(['session', 'show', '../bad']))).rejects.toMatchObject({
            code: 'invalid_session_id',
        });
        await expect(runSessionCommand(parseArgs(['session', 'show', 'session_missing']))).rejects.toMatchObject({
            code: 'session_not_found',
        });
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

type ReplayRecord =
    | { readonly kind: 'event'; readonly event: AgentEvent }
    | { readonly kind: 'coding.step'; readonly step: unknown }
    | { readonly kind: 'diagnostic'; readonly diagnostic: unknown };

type ReplayRecordCandidate = {
    readonly kind?: unknown;
    readonly event?: unknown;
    readonly step?: unknown;
    readonly diagnostic?: unknown;
};

function parseReplayRecords(output: string): readonly ReplayRecord[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => replayRecordFromUnknown(JSON.parse(line)));
}

function replayRecordFromUnknown(value: unknown): ReplayRecord {
    if (!isRecord(value)) {
        throw new TypeError('replay record must be an object');
    }
    switch (value.kind) {
        case 'event':
            return { kind: 'event', event: AgentEventSchema.parse(value.event) };
        case 'coding.step':
            return { kind: 'coding.step', step: value.step };
        case 'diagnostic':
            return { kind: 'diagnostic', diagnostic: value.diagnostic };
        default:
            throw new TypeError(`unsupported replay record kind: ${String(value.kind)}`);
    }
}

function eventRecords(records: readonly ReplayRecord[]): readonly AgentEvent[] {
    return records.flatMap((record) => (record.kind === 'event' ? [record.event] : []));
}

function codingStepRecords(records: readonly ReplayRecord[]): readonly unknown[] {
    return records.flatMap((record) => (record.kind === 'coding.step' ? [record.step] : []));
}

function diagnosticRecords(records: readonly ReplayRecord[]): readonly unknown[] {
    return records.flatMap((record) => (record.kind === 'diagnostic' ? [record.diagnostic] : []));
}

function providerFromPatchRequests(): ProviderAdapter {
    let turns = 0;
    return {
        async *streamTurn(request) {
            turns += 1;
            if (turns === 1) {
                yield toolCallChunk(request, 'session_patch_call', 'file.patch', {
                    patch: addFilePatch('.mctrl-session-replay.txt', 'replayed'),
                });
                yield completedChunk(request, 'patch requested', ['session_patch_call']);
                return;
            }
            yield completedChunk(request, 'patch applied after replay');
        },
    };
}

function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

function isRecord(value: unknown): value is ReplayRecordCandidate {
    return typeof value === 'object' && value !== null;
}
