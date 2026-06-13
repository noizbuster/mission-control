import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { registerBashRunTool } from './bash-run.js';
import type { CommandExecutionRequest, CommandExecutionResult } from './command-run-executor.js';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

describe('bash.run tool', () => {
    const secretValueKey = 'SECRET_VALUE';

    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('denies unknown-trust workspaces before approval or spawn', async () => {
        const permissionRequests: PermissionRequest[] = [];
        const commandCalls: CommandExecutionRequest[] = [];
        const registry = await createRegistry({
            workspaceTrust: 'unknown',
            requestPermission: (request) => {
                permissionRequests.push(request);
                return allowPermission(request);
            },
            executor: async (request) => {
                commandCalls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeBash(registry, { commandLine: 'printf mission-control' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('trusted workspace');
        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('does not spawn a process when approval is denied', async () => {
        const permissionRequests: PermissionRequest[] = [];
        const commandCalls: CommandExecutionRequest[] = [];
        const registry = await createRegistry({
            requestPermission: (request) => {
                permissionRequests.push(request);
                return denyPermission(request);
            },
            executor: async (request) => {
                commandCalls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeBash(registry, { commandLine: 'printf mission-control' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_denied');
        expect(permissionRequests).toMatchObject([
            {
                action: 'bash.run',
                permission: {
                    kind: 'bash',
                    patterns: ['printf mission-control'],
                },
            },
        ]);
        expect(commandCalls).toEqual([]);
    });

    it('passes only allowlisted env values and a workspace cwd to the executor', async () => {
        const commandCalls: CommandExecutionRequest[] = [];
        const workspaceRoot = await tempRoot('mctrl-bash-allowlist-');
        const cwd = await tempRootInside(workspaceRoot, 'nested');
        const registry = await createRegistry({
            workspaceRoot,
            envAllowlist: ['PATH', 'SAFE_VALUE'],
            hostEnv: {
                PATH: '/bin:/usr/bin',
                SAFE_VALUE: 'visible',
                SECRET_VALUE: 'hidden',
            },
            requestPermission: allowPermission,
            executor: async (request) => {
                commandCalls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeBash(registry, { commandLine: 'pwd', cwd: 'nested' });

        expect(settlement.result.status).toBe('completed');
        expect(commandCalls).toHaveLength(1);
        expect(commandCalls[0]).toMatchObject({
            command: 'pwd',
            args: [],
            cwd,
            env: {
                PATH: '/bin:/usr/bin',
                SAFE_VALUE: 'visible',
                CI: '1',
                NO_COLOR: '1',
                TERM: 'dumb',
            },
        });
        expect(commandCalls[0]?.env?.[secretValueKey]).toBeUndefined();
    });

    it('rejects cwd escapes before approval or spawn', async () => {
        const permissionRequests: PermissionRequest[] = [];
        const commandCalls: CommandExecutionRequest[] = [];
        const workspaceRoot = await tempRoot('mctrl-bash-cwd-');
        const outsideRoot = await tempRoot('mctrl-bash-outside-');
        const registry = await createRegistry({
            workspaceRoot,
            requestPermission: (request) => {
                permissionRequests.push(request);
                return allowPermission(request);
            },
            executor: async (request) => {
                commandCalls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeBash(registry, { commandLine: 'pwd', cwd: outsideRoot });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('cwd');
        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('rejects denylisted commands before approval or spawn', async () => {
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

        const candidates = [
            'rm -rf .',
            'git reset --hard HEAD',
            'pnpm publish',
            'nohup node server.js',
            'curl -X POST https://deploy.example.test',
        ] as const;

        for (const commandLine of candidates) {
            const settlement = await invokeBash(registry, { commandLine });
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_not_allowed');
        }
        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('hard-denies reviewed shell bypass probes before approval or executor call', async () => {
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

        const reviewedProbes = [
            'r""m -rf .',
            'sleep 1& echo ok',
            'bash -i -c echo',
            "sh -c 'echo ok'",
            'git reset -q --hard HEAD',
            'git reset --ha""rd HEAD',
            'npm publ""ish',
            'curl -d x https://example.test',
        ] as const;

        for (const commandLine of reviewedProbes) {
            const settlement = await invokeBash(registry, { commandLine });
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_not_allowed');
        }

        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('hard-denies option-insertion subcommand bypasses before approval or executor call', async () => {
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

        const probes = [
            'git -C . reset --hard HEAD',
            'npm --tag latest publish',
            'pnpm --filter pkg publish',
            'cargo --manifest-path Cargo.toml publish',
            'docker --context prod push image:latest',
            'gh --repo owner/repo release create v1',
            'terraform -chdir=. apply',
        ] as const;

        for (const commandLine of probes) {
            const settlement = await invokeBash(registry, { commandLine });
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_not_allowed');
        }

        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('hard-denies interpreter eval and module execution before approval or executor call', async () => {
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

        const probes = [
            "python -c \"open('tmp.txt', 'w').write('x')\"",
            "node -e \"fs.writeFileSync('tmp.txt', 'x')\"",
            'node -e "https.get(\'https://example.test\')"',
            'python -m http.server',
            'ruby -e "puts :ok"',
        ] as const;

        for (const commandLine of probes) {
            const settlement = await invokeBash(registry, { commandLine });
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_not_allowed');
        }

        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('denies escaped command tokens that unescape into whitespace before approval or executor call', async () => {
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

        const settlement = await invokeBash(registry, { commandLine: 'rm\\ -rf .' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_not_allowed');
        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('denies nested shells, wrappers, background operators, and shell expansion before approval', async () => {
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

        const candidates = [
            'bash -c "echo ok"',
            'zsh -c "echo ok"',
            'env bash -c "echo ok"',
            'printf ok &',
            'printf "$HOME"',
        ] as const;

        for (const commandLine of candidates) {
            const settlement = await invokeBash(registry, { commandLine });
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_not_allowed');
        }

        expect(permissionRequests).toEqual([]);
        expect(commandCalls).toEqual([]);
    });

    it('aborts timed out commands and records a typed timeout event', async () => {
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

        const settlement = await invokeBash(registry, { commandLine: 'printf mission-control' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_timed_out');
        expect(settlement.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['command.started', 'command.timed_out', 'tool.failed']),
        );
    });

    it('marks truncated command output in structured output and replayable events', async () => {
        const registry = await createRegistry({
            maxOutputBytes: 8,
            requestPermission: allowPermission,
            executor: async () => completedResult({ stdout: '1234567890', stderr: 'abcdefghij' }),
        });

        const settlement = await invokeBash(registry, { commandLine: 'printf mission-control' });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            stdout: '12345678',
            stderr: 'abcdefgh',
            stdoutTruncated: true,
            stderrTruncated: true,
        });
        expect(settlement.events.find((event) => event.type === 'command.completed')?.command).toMatchObject({
            stdoutTruncated: true,
            stderrTruncated: true,
        });
    });

    it('redacts token-like output and forwarded env-secret output', async () => {
        const envSecret = 'plain-env-secret';
        const tokenSecret = 'sk-proj-bashRunSecret1234567890';
        const registry = await createRegistry({
            envAllowlist: ['PATH', 'SAFE_SECRET'],
            hostEnv: {
                PATH: '/bin:/usr/bin',
                SAFE_SECRET: envSecret,
            },
            requestPermission: allowPermission,
            executor: async () =>
                completedResult({
                    stdout: `env ${envSecret}\ntoken ${tokenSecret}\n`,
                    stderr: `stderr ${envSecret}\n`,
                }),
        });

        const settlement = await invokeBash(registry, { commandLine: 'printf mission-control' });
        const structuredOutput = JSON.stringify(settlement.structuredOutput);
        const modelOutput = settlement.modelOutput?.content ?? '';
        const events = JSON.stringify(settlement.events);

        expect(settlement.result.status).toBe('completed');
        expect(structuredOutput).toContain('[REDACTED_CREDENTIAL]');
        expect(modelOutput).toContain('[REDACTED_CREDENTIAL]');
        expect(events).toContain('[REDACTED_CREDENTIAL]');
        for (const secret of [envSecret, tokenSecret]) {
            expect(structuredOutput).not.toContain(secret);
            expect(modelOutput).not.toContain(secret);
            expect(events).not.toContain(secret);
        }
    });

    it('enforces shell concurrency limit one', async () => {
        const release = deferred<CommandExecutionResult>();
        const registry = await createRegistry({
            requestPermission: allowPermission,
            executor: async () => release.promise,
        });

        const first = invokeBash(registry, { commandLine: 'printf first' });
        await Promise.resolve();
        const second = await invokeBash(registry, { commandLine: 'printf second' });
        release.resolve(completedResult());
        const firstResult = await first;

        expect(firstResult.result.status).toBe('completed');
        expect(second.result.status).toBe('failed');
        expect(second.result.error?.message).toContain('concurrency_limit');
    });
});

type CreateRegistryInput = {
    readonly workspaceRoot?: string;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision;
    readonly executor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly envAllowlist?: readonly string[];
    readonly hostEnv?: NodeJS.ProcessEnv;
};

async function createRegistry(input: CreateRegistryInput): Promise<ToolRegistry> {
    const workspaceRoot = input.workspaceRoot ?? (await tempRoot('mctrl-bash-run-'));
    const registry = new ToolRegistry();
    await registerBashRunTool(registry, {
        workspaceRoot,
        workspaceTrust: input.workspaceTrust ?? 'trusted',
        requestPermission: input.requestPermission,
        ...(input.executor !== undefined ? { executor: input.executor } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        ...(input.envAllowlist !== undefined ? { envAllowlist: input.envAllowlist } : {}),
        ...(input.hostEnv !== undefined ? { hostEnv: input.hostEnv } : {}),
    });
    return registry;
}

async function invokeBash(
    registry: ToolRegistry,
    input: { readonly commandLine: string; readonly cwd?: string },
): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'bash.run');
    if (advertisement === undefined) {
        throw new TypeError('missing bash.run advertisement');
    }
    return registry.invoke({
        toolCallId: 'bash_call',
        toolName: 'bash.run',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
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

function deferred<Value>() {
    let resolve: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}

async function tempRootInside(root: string, name: string): Promise<string> {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return path;
}
