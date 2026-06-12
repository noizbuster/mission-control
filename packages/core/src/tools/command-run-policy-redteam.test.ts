import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { type CommandExecutionRequest, type CommandExecutionResult, registerCommandRunTool } from './command-run.js';
import { COMMAND_RUN_POLICY_PROFILES, defaultCommandRunPolicyProfile } from './command-run-policy.js';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry.js';

const allowedHarnessArgs = ['--eval', "console.log('mission-control command.run harness ok')"] as const;

describe('command.run policy red-team gate', () => {
    it('keeps the fixed harness as the only declared policy profile', () => {
        expect(defaultCommandRunPolicyProfile).toBe('fixed-harness');
        expect(COMMAND_RUN_POLICY_PROFILES).toEqual(['fixed-harness']);
    });

    it('rejects non harness commands by default', async () => {
        const candidates: readonly CommandCandidate[] = [
            { command: 'cat', args: ['secret.txt'] },
            { command: 'bash', args: ['-lc', 'cat secret.txt'] },
            { command: 'pnpm', args: ['exec', 'vitest', 'run'] },
            { command: 'node', args: ['--eval', "console.log(process.env.MCTRL_DATA_DIR ?? '')"] },
        ];

        for (const candidate of candidates) {
            const result = await rejectBeforeApproval(candidate);
            expect(result.settlement.result.status).toBe('failed');
            expect(result.settlement.result.error?.message).toContain('command_not_allowed');
            expect(result.permissionRequests).toHaveLength(0);
            expect(result.commandCalls).toHaveLength(0);
        }
    });

    it('rejects shell metacharacters before approval or spawn', async () => {
        const candidates: readonly CommandCandidate[] = [
            {
                command: 'node',
                args: ['--eval', "console.log('mission-control command.run harness ok'); cat secret.txt"],
            },
            { command: 'node', args: [...allowedHarnessArgs, ';', 'cat', 'secret.txt'] },
            { command: 'sh', args: ['-c', 'node --eval "console.log(\'mission-control command.run harness ok\')"'] },
        ];

        for (const candidate of candidates) {
            const result = await rejectBeforeApproval(candidate);
            expect(result.settlement.result.error?.message).toContain('command_not_allowed');
            expect(result.permissionRequests).toHaveLength(0);
            expect(result.commandCalls).toHaveLength(0);
        }
    });

    it('rejects cwd escape probes before approval or spawn', async () => {
        const candidates: readonly CommandCandidate[] = [
            { command: 'node', args: ['--eval', "process.chdir('/tmp'); console.log(process.cwd())"] },
            {
                command: 'node',
                args: ['--eval', "console.log(require('node:fs').readFileSync('../secret.txt', 'utf8'))"],
            },
        ];

        for (const candidate of candidates) {
            const result = await rejectBeforeApproval(candidate);
            expect(result.settlement.result.error?.message).toContain('command_not_allowed');
            expect(result.permissionRequests).toHaveLength(0);
            expect(result.commandCalls).toHaveLength(0);
        }
    });

    it('fails timed out harness execution without projecting tool completion', async () => {
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
                                stdout: 'partial secret output',
                                stderr: '',
                                durationMs: 5,
                            }),
                        { once: true },
                    );
                }),
        });

        const settlement = await invokeCommand(registry, { command: 'node', args: allowedHarnessArgs });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_timed_out');
        expect(settlement.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['command.started', 'command.timed_out', 'tool.failed']),
        );
        expect(settlement.events.map((event) => event.type)).not.toContain('command.completed');
        expect(settlement.events.map((event) => event.type)).not.toContain('tool.completed');
    });

    it('fails interrupted harness execution without projecting tool completion', async () => {
        const controller = new AbortController();
        const started = deferred<AbortSignal>();
        const release = deferred<CommandExecutionResult>();
        const registry = await createRegistry({
            requestPermission: allowPermission,
            executor: (request) => {
                started.resolve(request.signal);
                return release.promise;
            },
        });
        const pending = invokeCommand(registry, { command: 'node', args: allowedHarnessArgs }, controller.signal);

        const executionSignal = await started.promise;
        controller.abort();
        release.resolve({
            exitCode: null,
            signal: 'SIGTERM',
            timedOut: false,
            stdout: 'interrupted secret output',
            stderr: '',
            durationMs: 1,
        });
        const settlement = await pending;

        expect(executionSignal.aborted).toBe(true);
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_failed');
        expect(settlement.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['command.started', 'command.failed', 'tool.failed']),
        );
        expect(settlement.events.map((event) => event.type)).not.toContain('command.completed');
        expect(settlement.events.map((event) => event.type)).not.toContain('tool.completed');
    });
});

type CommandCandidate = {
    readonly command: string;
    readonly args: readonly string[];
};

type RegistryInput = {
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision;
    readonly executor: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly timeoutMs?: number;
};

async function rejectBeforeApproval(candidate: CommandCandidate): Promise<{
    readonly settlement: ToolInvocationSettlement;
    readonly permissionRequests: readonly PermissionRequest[];
    readonly commandCalls: readonly CommandExecutionRequest[];
}> {
    const permissionRequests: PermissionRequest[] = [];
    const commandCalls: CommandExecutionRequest[] = [];
    const registry = await createRegistry({
        requestPermission: (request) => {
            permissionRequests.push(request);
            return allowPermission(request);
        },
        executor: async (request) => {
            commandCalls.push(request);
            return completedResult();
        },
    });
    return {
        settlement: await invokeCommand(registry, candidate),
        permissionRequests,
        commandCalls,
    };
}

async function createRegistry(input: RegistryInput): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerCommandRunTool(registry, {
        workspaceRoot: process.cwd(),
        requestPermission: input.requestPermission,
        executor: input.executor,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    return registry;
}

async function invokeCommand(
    registry: ToolRegistry,
    candidate: CommandCandidate,
    signal?: AbortSignal,
): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'command.run');
    if (advertisement === undefined) {
        throw new TypeError('missing command.run advertisement');
    }
    return registry.invoke({
        toolCallId: 'command_call',
        toolName: 'command.run',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(candidate),
        ...(signal !== undefined ? { signal } : {}),
    });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function completedResult(): CommandExecutionResult {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
    };
}

function deferred<Value>() {
    let resolve: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}
