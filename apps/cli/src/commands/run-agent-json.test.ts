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

describe('runAgent JSON reporter', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
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
            expect.arrayContaining(['approval.requested', 'approval.blocked']),
        );
        expect(parsed.some((event) => event.type === 'task.completed')).toBe(false);
        expect(JSON.stringify(parsed)).toContain('"policyDecision":"requires_approval"');
        expect(JSON.stringify(parsed)).toContain('"id":"file.patch"');
        expect(commandCalls).toBe(0);
        await expect(readFile(join(directory, '.headless-approval-required.txt'), 'utf8')).rejects.toThrow();
        await rm(directory, { recursive: true, force: true });
    });

    it('redacts OpenAI auth failures from JSON output and replay JSONL', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-openai-redaction-'));
        const sessionId = 'session_openai_redaction_json';
        const secret = 'sk-test-cli-json-secret';
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

        try {
            // When
            const output = await rejectedMessage(() =>
                runAgent(
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
                ),
            );
            const replay = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
            const sessionLog = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');

            // Then
            expect(output).toContain('[REDACTED_CREDENTIAL]');
            expect(replay).toContain('provider_auth_failed');
            expect(sessionLog).toContain('provider_auth_failed');
            expect(JSON.stringify({ output, replay, sessionLog })).not.toContain(secret);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

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

async function rejectedMessage(run: () => Promise<string>): Promise<string> {
    try {
        await run();
    } catch (error: unknown) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    throw new Error('expected runAgent to reject');
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
