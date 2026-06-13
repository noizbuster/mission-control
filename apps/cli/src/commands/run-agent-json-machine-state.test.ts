import {
    createDeterministicProvider,
    createOpenAIResponsesProvider,
    createStaticProviderCredentialResolver,
    missionControlDataDirEnvKey,
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
} from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { runSessionCommand } from './session.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type JsonOutputRecord = Record<string, unknown> & {
    readonly type?: string;
};

describe('runAgent JSON machine state', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('exposes machine-readable final run state for completed prompts', async () => {
        await useTempDataDir(tempDirs);
        const output = await runAgent(
            parseArgs(['run', 'summarize this repository', '--json', '--session', 'session_json_completed_state']),
        );
        const records = parseJsonRecords(output);

        expect(lastRecord(records)).toMatchObject({
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

        expect(records.map((record) => record.type)).toContain('run.failed');
        expect(lastRecord(records)).toMatchObject({
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

        expect(records.map((record) => record.type)).toContain('run.interrupted');
        expect(records.map((record) => record.type)).not.toContain('run.failed');
        expect(lastRecord(records)).toMatchObject({
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

    it('redacts OpenAI auth failures from JSON output and replay JSONL', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-openai-redaction-'));
        tempDirs.push(dataDir);
        const sessionId = 'session_openai_redaction_json';
        const secret = 'sk-test-cli-json-secret';
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

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

        expect(output).toContain('[REDACTED_CREDENTIAL]');
        expect(replay).toContain('provider_auth_failed');
        expect(sessionLog).toContain('provider_auth_failed');
        expect(JSON.stringify({ output, replay, sessionLog })).not.toContain(secret);
    });
});

async function useTempDataDir(tempDirs: string[]): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-json-data-'));
    tempDirs.push(dataDir);
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

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
                message: `provider_auth_failed: invalid key ${secret}`,
                status: 401,
                code: 'provider_auth_failed',
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
