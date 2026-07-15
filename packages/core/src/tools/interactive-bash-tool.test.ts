import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createInteractiveBashToolRegistration,
    findSubcommandIndex,
    type InteractiveBashExecutor,
    type InteractiveBashOutput,
    isTmuxAvailable,
    tokenizeTmuxCommand,
} from './interactive-bash-tool';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

describe('interactive_bash tool', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    describe('config gating', () => {
        it('returns a registration when tmux is available', async () => {
            const registration = await createInteractiveBashToolRegistration({
                workspaceRoot: await tempRoot(),
                requestPermission: allowPermission,
                tmuxAvailable: true,
                executor: fakeExecutor(),
            });
            expect(registration).not.toBeNull();
            expect(registration?.name).toBe('interactive_bash');
        });

        it('returns null (not registered) when tmux is absent', async () => {
            const registration = await createInteractiveBashToolRegistration({
                workspaceRoot: await tempRoot(),
                requestPermission: allowPermission,
                tmuxAvailable: false,
                executor: fakeExecutor(),
            });
            expect(registration).toBeNull();
        });

        it('isTmuxAvailable honors the explicit override in both directions', () => {
            expect(isTmuxAvailable(true)).toBe(true);
            expect(isTmuxAvailable(false)).toBe(false);
        });

        it('registers nothing when tmux absent via registerInteractiveBashTool', async () => {
            const registry = new ToolRegistry();
            const { registerInteractiveBashTool } = await import('./interactive-bash-tool');
            const advertisement = await registerInteractiveBashTool(registry, {
                workspaceRoot: await tempRoot(),
                requestPermission: allowPermission,
                tmuxAvailable: false,
                executor: fakeExecutor(),
            });
            expect(advertisement).toBeNull();
            expect(registry.advertise().find((tool) => tool.name === 'interactive_bash')).toBeUndefined();
        });
    });

    describe('dangerous-subcommand containment', () => {
        it('blocks kill-server as prohibited before spawn or approval', async () => {
            const calls = trackCalls();
            const registry = await createRegistry({
                tmuxAvailable: true,
                requestPermission: captureAndAllow(calls.permissionRequests),
                executor: calls.executor,
            });

            const settlement = await invoke(registry, { tmuxCommand: 'kill-server' });

            expect(settlement.structuredOutput.status).toBe('blocked');
            expect(settlement.structuredOutput.blockedReason).toContain('prohibited');
            expect(calls.permissionRequests).toHaveLength(0);
            expect(calls.executorCalls).toHaveLength(0);
        });

        it('blocks capture-pane with a Bash-tool hint before spawn or approval', async () => {
            const calls = trackCalls();
            const registry = await createRegistry({
                tmuxAvailable: true,
                requestPermission: captureAndAllow(calls.permissionRequests),
                executor: calls.executor,
            });

            const settlement = await invoke(registry, { tmuxCommand: 'capture-pane -p -t dev' });

            expect(settlement.structuredOutput.status).toBe('blocked');
            expect(settlement.structuredOutput.blockedReason).toContain('blocked');
            expect(calls.permissionRequests).toHaveLength(0);
            expect(calls.executorCalls).toHaveLength(0);
        });

        it('rejects an empty tmux command before spawn or approval', async () => {
            const calls = trackCalls();
            const registry = await createRegistry({
                tmuxAvailable: true,
                requestPermission: captureAndAllow(calls.permissionRequests),
                executor: calls.executor,
            });

            const settlement = await invoke(registry, { tmuxCommand: '   ' });

            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_not_allowed');
        });
    });

    describe('approval and execution', () => {
        it('requires approval before spawning tmux', async () => {
            const calls = trackCalls();
            const registry = await createRegistry({
                tmuxAvailable: true,
                requestPermission: (request) => {
                    calls.permissionRequests.push(request);
                    return denyPermission(request);
                },
                executor: calls.executor,
            });

            const settlement = await invoke(registry, { tmuxCommand: 'new-session -d -s dev' });

            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('approval_denied');
            expect(calls.permissionRequests).toMatchObject([
                {
                    action: 'interactive_bash',
                    permission: { kind: 'bash', patterns: ['new-session -d -s dev'] },
                },
            ]);
            expect(calls.executorCalls).toHaveLength(0);
        });

        it('spawns tmux with the tokenized args after approval and returns stdout', async () => {
            const calls = trackCalls();
            const registry = await createRegistry({
                tmuxAvailable: true,
                requestPermission: captureAndAllow(calls.permissionRequests),
                executor: fakeExecutorReturning({ exitCode: 0, stdout: 'sessions: 1\n', stderr: '' }),
            });

            const settlement = await invoke(registry, { tmuxCommand: 'list-sessions' });

            expect(settlement.result.status).toBe('completed');
            expect(settlement.structuredOutput.status).toBe('completed');
            expect(settlement.structuredOutput.exitCode).toBe(0);
            expect(settlement.structuredOutput.stdout).toContain('sessions: 1');
        });

        it('surfaces a nonzero exit as a failed status without throwing', async () => {
            const registry = await createRegistry({
                tmuxAvailable: true,
                requestPermission: allowPermission,
                executor: fakeExecutorReturning({ exitCode: 1, stdout: '', stderr: 'no server running' }),
            });

            const settlement = await invoke(registry, { tmuxCommand: 'list-sessions' });

            expect(settlement.result.status).toBe('completed');
            expect(settlement.structuredOutput.status).toBe('failed');
            expect(settlement.structuredOutput.exitCode).toBe(1);
            expect(settlement.structuredOutput.stderr).toContain('no server running');
        });
    });

    describe('tokenizeTmuxCommand', () => {
        it('splits on whitespace', () => {
            expect(tokenizeTmuxCommand('new-session -d -s dev')).toEqual(['new-session', '-d', '-s', 'dev']);
        });

        it('preserves quoted spaces', () => {
            expect(tokenizeTmuxCommand("send-keys -t dev 'echo hello world' Enter")).toEqual([
                'send-keys',
                '-t',
                'dev',
                'echo hello world',
                'Enter',
            ]);
        });

        it('handles backslash escapes', () => {
            expect(tokenizeTmuxCommand('a\\ b c')).toEqual(['a b', 'c']);
        });

        it('rejects an unterminated quote', () => {
            expect(() => tokenizeTmuxCommand("send-keys 'unclosed")).toThrow();
        });
    });

    describe('findSubcommandIndex', () => {
        it('returns 0 for a bare subcommand', () => {
            expect(findSubcommandIndex(['list-sessions'])).toBe(0);
        });

        it('skips a global option that takes an argument', () => {
            expect(findSubcommandIndex(['-L', 'mysock', 'list-sessions'])).toBe(2);
        });

        it('skips a leading short flag without an argument', () => {
            expect(findSubcommandIndex(['-V'])).toBe(-1);
            expect(findSubcommandIndex(['-u', 'list-sessions'])).toBe(1);
        });

        it('honors the -- separator', () => {
            expect(findSubcommandIndex(['--', 'list-sessions'])).toBe(1);
            expect(findSubcommandIndex(['--'])).toBe(-1);
        });
    });
});

type CallTracker = {
    readonly permissionRequests: PermissionRequest[];
    readonly executorCalls: ReadonlyArray<{ readonly args: readonly string[] }>;
    readonly executor: InteractiveBashExecutor;
};

function trackCalls(): CallTracker {
    const permissionRequests: PermissionRequest[] = [];
    const executorCalls: Array<{ readonly args: readonly string[] }> = [];
    const executor: InteractiveBashExecutor = async (request) => {
        executorCalls.push({ args: request.args });
        return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
    };
    return { permissionRequests, executorCalls, executor };
}

function captureAndAllow(sink: PermissionRequest[]): (request: PermissionRequest) => PermissionDecision {
    return (request) => {
        sink.push(request);
        return allowPermission(request);
    };
}

function fakeExecutor(): InteractiveBashExecutor {
    return async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1 });
}

function fakeExecutorReturning(result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}): InteractiveBashExecutor {
    return async () => ({
        exitCode: result.exitCode,
        signal: null,
        timedOut: false,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 1,
    });
}

type CreateRegistryInput = {
    readonly tmuxAvailable: boolean;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision;
    readonly executor: InteractiveBashExecutor;
    readonly timeoutMs?: number;
};

async function createRegistry(input: CreateRegistryInput): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const registration = await createInteractiveBashToolRegistration({
        workspaceRoot: await tempRoot(),
        requestPermission: input.requestPermission,
        tmuxAvailable: input.tmuxAvailable,
        executor: input.executor,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (registration === null) {
        throw new TypeError('interactive_bash registration was null; tmuxAvailable must be true in this setup');
    }
    registry.register(registration);
    return registry;
}

async function invoke(
    registry: ToolRegistry,
    input: { readonly tmuxCommand: string },
): Promise<ToolInvocationSettlement & { readonly structuredOutput: InteractiveBashOutput }> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'interactive_bash');
    if (advertisement === undefined) {
        throw new TypeError('missing interactive_bash advertisement');
    }
    return registry.invoke({
        toolCallId: 'interactive_bash_call',
        toolName: 'interactive_bash',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    }) as Promise<ToolInvocationSettlement & { readonly structuredOutput: InteractiveBashOutput }>;
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function denyPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason: 'test deny' };
}

async function tempRoot(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'mctrl-interactive-bash-'));
    tempRoots.push(path);
    return path;
}
