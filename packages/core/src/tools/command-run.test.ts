import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { type CommandExecutionRequest, type CommandExecutionResult, registerCommandRunTool } from './command-run.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowedHarnessArgs = ['--eval', "console.log('mission-control command.run harness ok')"] as const;

describe('command.run tool', () => {
    it('does not spawn a process when approval is denied', async () => {
        // Given
        const calls: CommandExecutionRequest[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry({
            requestPermission: (request) => {
                permissionRequests.push(request);
                return denyPermission(request);
            },
            executor: async (request) => {
                calls.push(request);
                return completedResult();
            },
        });

        // When
        const result = await invokeCommand(registry, 'node', allowedHarnessArgs);

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('approval_denied');
        expect(calls).toHaveLength(0);
        expect(permissionRequests).toMatchObject([
            {
                action: 'command.run',
                permission: {
                    kind: 'bash',
                    patterns: ["node --eval console.log('mission-control command.run harness ok')"],
                },
            },
        ]);
    });

    it('rejects non harness commands by default', async () => {
        // Given
        const calls: CommandExecutionRequest[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry({
            requestPermission: (request) => {
                permissionRequests.push(request);
                return allowPermission(request);
            },
            executor: async (request) => {
                calls.push(request);
                return completedResult();
            },
        });

        // When
        const result = await invokeCommand(registry, 'rm', ['-rf', '.']);

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('command_not_allowed');
        expect(permissionRequests).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });

    it('rejects provider-created vitest targets before approval or spawn', async () => {
        // Given
        const calls: CommandExecutionRequest[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry({
            requestPermission: (request) => {
                permissionRequests.push(request);
                return allowPermission(request);
            },
            executor: async (request) => {
                calls.push(request);
                return completedResult({ stdout: 'exfiltrated workspace data' });
            },
        });

        // When
        const result = await invokeCommand(registry, 'pnpm', [
            'exec',
            'vitest',
            'run',
            'tmp/provider-created-exfil.test.ts',
        ]);

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('command_not_allowed');
        expect(permissionRequests).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });

    it('rejects mutable package scripts before approval or spawn', async () => {
        // Given
        const calls: CommandExecutionRequest[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry({
            requestPermission: (request) => {
                permissionRequests.push(request);
                return allowPermission(request);
            },
            executor: async (request) => {
                calls.push(request);
                return completedResult({ stdout: 'script-controlled output' });
            },
        });

        // When
        const result = await invokeCommand(registry, 'pnpm', ['typecheck']);

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('command_not_allowed');
        expect(permissionRequests).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });

    it('aborts timed out commands and records a typed timeout event', async () => {
        // Given
        const registry = await createRegistry({
            timeoutMs: 5,
            requestPermission: allowPermission,
            executor: (request) =>
                new Promise<CommandExecutionResult>((resolve) => {
                    request.signal.addEventListener(
                        'abort',
                        () =>
                            resolve({
                                exitCode: null,
                                signal: 'SIGTERM',
                                timedOut: true,
                                stdout: 'partial stdout',
                                stderr: '',
                                durationMs: 5,
                            }),
                        { once: true },
                    );
                }),
        });

        // When
        const result = await invokeCommand(registry, 'node', allowedHarnessArgs);

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('command_timed_out');
        expect(result.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['command.started', 'command.timed_out', 'tool.failed']),
        );
        expect(result.events.find((event) => event.type === 'command.timed_out')?.command?.timedOut).toBe(true);
    });

    it('marks truncated command output in structured output and replayable events', async () => {
        // Given
        const registry = await createRegistry({
            maxOutputBytes: 8,
            requestPermission: allowPermission,
            executor: async () => completedResult({ stdout: '1234567890', stderr: 'abcdefghij' }),
        });

        // When
        const result = await invokeCommand(registry, 'node', allowedHarnessArgs);

        // Then
        expect(result.result.status).toBe('completed');
        expect(result.structuredOutput).toMatchObject({
            stdout: '12345678',
            stderr: 'abcdefgh',
            stdoutTruncated: true,
            stderrTruncated: true,
        });
        expect(result.events.find((event) => event.type === 'command.completed')?.command).toMatchObject({
            stdoutTruncated: true,
            stderrTruncated: true,
        });
    });

    it('redacts credential families from command output and model output', async () => {
        // Given
        const secrets = commandSecretFixtures();
        const registry = await createRegistry({
            requestPermission: allowPermission,
            executor: async () =>
                completedResult({
                    stdout: commandSecretPayload(secrets),
                    stderr: commandSecretPayload(secrets),
                }),
        });

        // When
        const result = await invokeCommand(registry, 'node', allowedHarnessArgs);

        // Then
        const structuredOutput = JSON.stringify(result.structuredOutput);
        const modelOutput = result.modelOutput?.content ?? '';
        const events = JSON.stringify(result.events);
        expect(result.result.status).toBe('completed');
        expect(structuredOutput).toContain('[REDACTED_CREDENTIAL]');
        expect(modelOutput).toContain('[REDACTED_CREDENTIAL]');
        expect(events).toContain('[REDACTED_CREDENTIAL]');
        for (const secret of secrets) {
            expect(structuredOutput).not.toContain(secret);
            expect(modelOutput).not.toContain(secret);
            expect(events).not.toContain(secret);
        }
    });

    it('marks nonzero command exits as failed tool settlements', async () => {
        // Given
        const registry = await createRegistry({
            requestPermission: allowPermission,
            executor: async () => ({
                exitCode: 1,
                signal: null,
                timedOut: false,
                stdout: 'tests failed',
                stderr: '',
                durationMs: 2,
            }),
        });

        // When
        const result = await invokeCommand(registry, 'node', allowedHarnessArgs);

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('command_failed');
        expect(result.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['command.started', 'command.failed', 'tool.failed']),
        );
        expect(result.events.map((event) => event.type)).not.toContain('tool.completed');
    });

    it('enforces shell concurrency limit one', async () => {
        // Given
        const release = deferred<CommandExecutionResult>();
        const registry = await createRegistry({
            requestPermission: allowPermission,
            executor: () => release.promise,
        });

        // When
        const first = invokeCommand(registry, 'node', allowedHarnessArgs);
        await Promise.resolve();
        const second = await invokeCommand(registry, 'node', allowedHarnessArgs);
        release.resolve(completedResult());
        const firstResult = await first;

        // Then
        expect(firstResult.result.status).toBe('completed');
        expect(second.result.status).toBe('failed');
        expect(second.result.error?.message).toContain('concurrency_limit');
    });

    it('keeps the concurrency slot until a timed out executor settles', async () => {
        // Given
        const release = deferred<CommandExecutionResult>();
        const aborted = deferred<void>();
        const registry = await createRegistry({
            timeoutMs: 5,
            requestPermission: allowPermission,
            executor: (request) => {
                request.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
                return release.promise;
            },
        });

        // When
        let firstSettled = false;
        const first = invokeCommand(registry, 'node', allowedHarnessArgs).finally(() => {
            firstSettled = true;
        });
        await aborted.promise;
        await nextEventLoopTurn();
        expect(firstSettled).toBe(false);
        const second = await invokeCommand(registry, 'node', allowedHarnessArgs);
        release.resolve({
            exitCode: null,
            signal: 'SIGTERM',
            timedOut: true,
            stdout: '',
            stderr: '',
            durationMs: 5,
        });
        const firstResult = await first;

        // Then
        expect(second.result.status).toBe('failed');
        expect(second.result.error?.message).toContain('concurrency_limit');
        expect(firstResult.result.status).toBe('failed');
        expect(firstResult.result.error?.message).toContain('command_timed_out');
    });

    it('runs an allowed static node harness without workspace executable code', async () => {
        // Given
        const registry = await createRegistry({
            workspaceRoot: process.cwd(),
            timeoutMs: 20_000,
            maxOutputBytes: 4096,
            requestPermission: allowPermission,
        });

        // When
        const result = await invokeCommand(registry, 'node', allowedHarnessArgs);

        // Then
        expect(result.result.status).toBe('completed');
        expect(result.structuredOutput).toMatchObject({
            status: 'completed',
            exitCode: 0,
            command: ['node', ...allowedHarnessArgs],
        });
    });
});

type PermissionResolver = (request: PermissionRequest) => PermissionDecision;

type CreateRegistryInput = {
    readonly workspaceRoot?: string;
    readonly requestPermission: PermissionResolver;
    readonly executor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
};

async function createRegistry(input: CreateRegistryInput): Promise<ToolRegistry> {
    const workspaceRoot = input.workspaceRoot ?? (await mkdtemp(join(tmpdir(), 'mctrl-command-run-')));
    const registry = new ToolRegistry();
    await registerCommandRunTool(registry, {
        workspaceRoot,
        requestPermission: input.requestPermission,
        ...(input.executor !== undefined ? { executor: input.executor } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });
    if (input.workspaceRoot === undefined) {
        await rm(workspaceRoot, { recursive: true, force: true });
    }
    return registry;
}

async function invokeCommand(registry: ToolRegistry, command: string, args: readonly string[]) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'command.run');
    if (advertisement === undefined) {
        throw new TypeError('missing command.run advertisement');
    }
    return registry.invoke({
        toolCallId: 'command_call',
        toolName: 'command.run',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ command, args }),
    });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function denyPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason: 'test deny' };
}

function completedResult(input: { readonly stdout?: string; readonly stderr?: string } = {}): CommandExecutionResult {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: input.stdout ?? 'ok',
        stderr: input.stderr ?? '',
        durationMs: 1,
    };
}

function commandSecretFixtures(): readonly string[] {
    return [
        ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJjb21tYW5kIjoibWlzc2lvbi1jb250cm9sIn0', 'signaturetest'].join('.'),
        ['ghp', 'testCommandToken1234567890'].join('_'),
        ['github', 'pat', 'test', 'command1234567890'].join('_'),
        ['AKIA', 'TESTCOMMAND12345'].join(''),
        ['Bearer', ['bearer', 'testCommandToken1234567890'].join('_')].join(' '),
        [
            ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
            'command-secret-body',
            ['-----END', 'PRIVATE KEY-----'].join(' '),
        ].join('\n'),
        ['sk', 'proj', 'testCommandOpenAI1234567890'].join('-'),
        ['sk', 'ant', 'api03', 'testCommandAnthropic1234567890'].join('-'),
        ['AIza', 'CommandGoogleToken1234567890'].join(''),
        ['sk', 'or', 'v1', 'testCommandCompatible1234567890'].join('-'),
    ];
}

function commandSecretPayload(secrets: readonly string[]): string {
    return secrets.map((secret, index) => `secret ${index}: ${secret}`).join('\n');
}

function deferred<Value>() {
    let resolve: (value: Value) => void = () => {};
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

function nextEventLoopTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
