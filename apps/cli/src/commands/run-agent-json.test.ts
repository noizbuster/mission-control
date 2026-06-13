import {
    createDeterministicProvider,
    createOpenAIResponsesProvider,
    createStaticProviderCredentialResolver,
    missionControlDataDirEnvKey,
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
} from '@mission-control/core';
import { AgentEventSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { runSessionCommand } from './session.js';
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
        });
        const lines = output.trim().split('\n');
        const parsed = lines.map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.some((event) => event.type === 'session.started')).toBe(true);
        expect(parsed.some((event) => event.type === 'task.completed')).toBe(true);
    });

    it('json output exposes machine-readable final run state for completed prompts', async () => {
        await useTempDataDir(tempDirs);
        const output = await runAgent(
            parseArgs(['run', 'summarize this repository', '--json', '--session', 'session_json_completed_state']),
        );
        const records = parseJsonRecords(output);
        const finalRecord = lastRecord(records);

        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_completed_state',
            status: 'completed',
            runId: expect.any(String),
            machine: {
                run: {
                    runId: expect.any(String),
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

    it('json reporter surfaces approval-required for non-interactive effectful provider tools', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-headless-tools-'));
        let commandCalls = 0;
        const output = await runAgent(parseArgs(['run', 'try a headless command', '--json']), {
            workspaceRoot: directory,
            commandExecutor: async () => {
                commandCalls += 1;
                throw new Error('command executor must not run in headless approval-required flow');
            },
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'json_patch_call',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({
                        patch: addFilePatch('.headless-approval-required.txt', 'should not apply'),
                    }),
                },
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'json_command_call',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({ command: 'pnpm', args: ['test'] }),
                },
                { kind: 'response_completed', content: 'should not complete task' },
            ]),
        });
        const parsed = output
            .trim()
            .split('\n')
            .map((line) => AgentEventSchema.parse(JSON.parse(line)));

        expect(parsed.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.requested', 'approval.blocked', 'run.blocked']),
        );
        expect(parsed.some((event) => event.type === 'task.completed')).toBe(false);
        expect(parsed.some((event) => event.type === 'task.failed')).toBe(false);
        expect(JSON.stringify(parsed)).toContain('"policyDecision":"requires_approval"');
        expect(JSON.stringify(parsed)).toContain('"id":"file.patch"');
        expect(parsed.find((event) => event.type === 'run.blocked')?.run).toMatchObject({
            state: 'blocked_on_approval',
            toolCallId: 'json_patch_call',
        });
        expect(commandCalls).toBe(0);
        await expect(readFile(join(directory, '.headless-approval-required.txt'), 'utf8')).rejects.toThrow();
        await rm(directory, { recursive: true, force: true });
    });

    it('redacts OpenAI auth failures from JSON output and replay JSONL', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-openai-redaction-'));
        tempDirs.push(dataDir);
        const sessionId = 'session_openai_redaction_json';
        const secret = 'sk-test-cli-json-secret';
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

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
        const sessionLog = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');

        // Then
        expect(output).toContain('[REDACTED_CREDENTIAL]');
        expect(replay).toContain('provider_auth_failed');
        expect(sessionLog).toContain('provider_auth_failed');
        expect(JSON.stringify({ output, replay, sessionLog })).not.toContain(secret);
    });

    it('returns machine-readable failed state instead of rejecting on provider failure', async () => {
        await useTempDataDir(tempDirs);
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
            runId: expect.any(String),
            machine: {
                run: {
                    runId: expect.any(String),
                    status: 'failed',
                },
            },
        });
    });

    it('returns machine-readable interrupted state instead of rejecting on provider abort', async () => {
        await useTempDataDir(tempDirs);
        const output = await runAgent(
            parseArgs(['run', 'interrupt provider', '--json', '--session', 'session_json_interrupted']),
            {
                provider: createDeterministicProvider([
                    {
                        kind: 'response_failed',
                        error: {
                            code: 'provider_aborted',
                            message: 'provider aborted',
                            retryable: true,
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
            runId: expect.any(String),
            machine: {
                run: {
                    runId: expect.any(String),
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
    const record = records.at(-1);
    if (record === undefined) {
        throw new Error('expected at least one JSON record');
    }
    return record;
}

async function useTempDataDir(tempDirs: string[]): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-json-data-'));
    tempDirs.push(dataDir);
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
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
