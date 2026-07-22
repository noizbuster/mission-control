// allow: SIZE_OK -- HEAD 372 -> current 373 pure LOC; one JSON/JSONL command-surface integration matrix with shared lifecycle fixtures.
import {
    createDeterministicProvider,
    createOpenAIResponsesProvider,
    createStaticProviderCredentialResolver,
    missionControlDataDirEnvKey,
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
    readLocalSessionReplay,
} from '@mission-control/core';
import { AgentEventSchema } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { captureSequentialProvider } from './compact-command-test-support';
import { runAgent } from './run-agent';
import { runSessionCommand } from './session';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type JsonOutputRecord = Record<string, unknown> & {
    readonly type?: string;
    readonly sessionId?: string;
    readonly status?: string;
    readonly runId?: string;
    readonly approvalId?: string;
    readonly toolCallId?: string;
};

describe('runAgent JSON reporter', () => {
    const tempDirs: string[] = [];

    beforeEach(async () => {
        await useTempDataDir(tempDirs);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('json reporter emits valid JSON Lines', async () => {
        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            thinking: false,
        });
        const lines = output.trim().split('\n');
        const parsed = lines.map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.some((event) => event.type === 'session.started')).toBe(true);
        expect(parsed.some((event) => event.type === 'task.completed')).toBe(true);
    });

    it('json output exposes machine-readable final run state for completed prompts', async () => {
        const output = await runAgent(
            parseArgs(['run', 'summarize this repository', '--json', '--session', 'session_json_completed_state']),
            {
                provider: captureSequentialProvider([], ['exploratory-research', 'true', 'summarized']),
            },
        );
        const records = parseJsonRecords(output);
        const finalRecord = lastRecord(records);

        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_completed_state',
            status: 'completed',
            runId: expect.stringMatching(/^run_.+/),
            machine: {
                run: {
                    runId: expect.stringMatching(/^run_.+/),
                    status: 'completed',
                },
            },
        });
    });

    it('json output includes selected provider and model metadata', async () => {
        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            thinking: false,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.find((event) => event.type === 'session.started')?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(parsed.find((event) => event.type === 'task.completed')?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('json output includes generated provider and model metadata', async () => {
        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            thinking: false,
            modelProviderSelection: {
                providerID: 'anthropic',
                modelID: 'claude-sonnet-4-6',
            },
        });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.find((event) => event.type === 'session.started')?.modelProviderSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
        });
        expect(parsed.find((event) => event.type === 'task.completed')?.modelProviderSelection).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
        });
    });

    it('json reporter emits graph events for authored graph', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-cli-graph-'));
        const graphPath = join(directory, 'research.graph.json');
        await writeFile(graphPath, JSON.stringify(createGraphSpec()), 'utf8');
        vi.stubEnv('INIT_CWD', directory);

        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            thinking: false,
            graphPath: 'research.graph.json',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        await rm(directory, { recursive: true, force: true });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.map((event) => event.type)).toEqual(
            expect.arrayContaining(['graph.started', 'node.completed', 'graph.completed']),
        );
        expect(parsed.find((event) => event.type === 'node.completed')?.modelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('json reporter surfaces approval-required for non-interactive approval gates', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-headless-tools-'));
        const graphPath = join(directory, 'approval-required.graph.json');
        await writeFile(graphPath, JSON.stringify(createApprovalGraphSpec()), 'utf8');

        const output = await runAgent({
            mode: 'json',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            thinking: false,
            graphPath,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.requested', 'policy.blocked', 'graph.failed']),
        );
        expect(parsed.some((event) => event.type === 'task.completed')).toBe(false);
        expect(parsed.some((event) => event.type === 'task.failed')).toBe(false);
        expect(JSON.stringify(parsed)).toContain('"policyDecision":"requires_approval"');
        expect(parsed.find((event) => event.type === 'graph.failed')?.abg).toMatchObject({
            graphId: 'cli-approval-required',
        });
        await expect(readFile(join(directory, '.headless-approval-required.txt'), 'utf8')).rejects.toThrow();
        await rm(directory, { recursive: true, force: true });
    });

    it('redacts OpenAI auth failures from JSON output and replay JSONL', async () => {
        // Given
        const sessionId = 'session_openai_redaction_json';
        const secret = 'sk-test-cli-json-secret';

        // When
        const output = await runAgent(
            parseArgs([
                'run',
                'trigger OpenAI auth failure',
                '--json',
                '--session',
                sessionId,
                '--model',
                'openai/gpt-5',
            ]),
            {
                provider: createOpenAIProviderAuthFailure(secret),
            },
        );
        const replay = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const storedReplay = await readReplay(sessionId);

        // Then
        expect(output).toContain('[REDACTED_CREDENTIAL]');
        expect(replay.stdout).toContain('provider_auth_failed');
        expect(storedReplay.projection.envelopes.some((envelope) => envelope.event.type === 'run.failed')).toBe(true);
        expect(JSON.stringify({ output, replay, storedReplay })).not.toContain(secret);
    });

    it('returns machine-readable failed state instead of rejecting on provider failure', async () => {
        const output = await runAgent(
            parseArgs(['run', 'fail provider', '--json', '--session', 'session_json_failed']),
            {
                provider: createDeterministicProvider([
                    {
                        kind: 'response_failed',
                        error: {
                            code: 'unknown',
                            message: 'provider exploded',
                            retryable: false,
                        },
                    },
                ]),
            },
        );
        const records = parseJsonRecords(output);
        const finalRecord = lastRecord(records);

        expect(records.map((record) => record.type)).toContain('run.failed');
        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_failed',
            status: 'failed',
            runId: expect.stringMatching(/^run_.+/),
            machine: {
                run: {
                    runId: expect.stringMatching(/^run_.+/),
                    status: 'failed',
                },
            },
        });
    });

    it('returns machine-readable interrupted state instead of rejecting on provider abort', async () => {
        const output = await runAgent(
            parseArgs(['run', 'interrupt provider', '--json', '--session', 'session_json_interrupted']),
            {
                provider: createDeterministicProvider([
                    {
                        kind: 'response_failed',
                        error: {
                            code: 'provider_aborted',
                            message: 'provider aborted',
                            retryable: false,
                        },
                    },
                ]),
            },
        );
        const records = parseJsonRecords(output);
        const finalRecord = lastRecord(records);

        expect(records.map((record) => record.type)).toContain('run.interrupted');
        expect(records.map((record) => record.type)).not.toContain('run.failed');
        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_interrupted',
            status: 'interrupted',
            runId: expect.stringMatching(/^run_.+/),
            machine: {
                run: {
                    runId: expect.stringMatching(/^run_.+/),
                    status: 'interrupted',
                },
            },
        });
    });
});

function parseJsonRecords(output: string): readonly JsonOutputRecord[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as JsonOutputRecord);
}

function lastRecord(records: readonly JsonOutputRecord[]): JsonOutputRecord {
    for (let i = records.length - 1; i >= 0; i -= 1) {
        const candidate = records[i];
        if (candidate !== undefined && candidate.type !== 'session.finalize') {
            return candidate;
        }
    }
    throw new Error('expected at least one JSON record');
}

async function readReplay(sessionId: string) {
    const result = await readLocalSessionReplay({ sessionId });
    if (result.kind !== 'found') {
        throw new Error(`expected replay for ${sessionId}`);
    }
    return result.replay;
}

async function useTempDataDir(tempDirs: string[]): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-json-data-'));
    tempDirs.push(dataDir);
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

function createGraphSpec() {
    return {
        id: 'cli-research',
        entryNodeId: 'answer',
        nodes: [
            {
                id: 'answer',
                kind: 'llm',
            },
        ],
        edges: [],
        rules: [],
        policies: [],
    };
}

function createApprovalGraphSpec() {
    return {
        id: 'cli-approval-required',
        entryNodeId: 'approval',
        nodes: [
            {
                id: 'approval',
                kind: 'human-approval',
                config: {
                    action: 'file.patch',
                    reason: 'non-interactive approval gate requires approval',
                },
            },
        ],
        edges: [],
        rules: [],
        policies: [],
    };
}

function createOpenAIProviderAuthFailure(secret: string) {
    return createOpenAIResponsesProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            {
                providerID: 'openai',
                type: 'apiKey',
                apiKey: secret,
                createdAt: '2026-06-09T10:00:00.000Z',
                updatedAt: '2026-06-09T10:00:00.000Z',
            },
        ]),
        transport: throwingTransport(
            new OpenAIResponsesTransportError({
                status: 401,
                message: `bad credential ${secret}`,
            }),
        ),
    });
}

function throwingTransport(error: OpenAIResponsesTransportError): OpenAIResponsesTransport {
    return {
        stream: () => rejectingIterable(error),
    };
}

function rejectingIterable(error: OpenAIResponsesTransportError): AsyncIterable<unknown> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next: () => Promise.reject(error),
            };
        },
    };
}
