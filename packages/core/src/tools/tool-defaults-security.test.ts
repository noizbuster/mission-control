import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandExecutionResult, registerCommandRunTool } from './command-run.js';
import { resolveFilePatchOptions } from './file-patch-schemas.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowedHarnessArgs = ['--eval', "console.log('mission-control command.run harness ok')"] as const;

describe('tool safety defaults', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.useRealTimers();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('defaults command.run timeout to 120 seconds', async () => {
        // Given
        vi.useFakeTimers();
        const workspaceRoot = await tempRoot('mctrl-command-default-');
        const started = deferred<AbortSignal>();
        const registry = new ToolRegistry();
        await registerCommandRunTool(registry, {
            workspaceRoot,
            requestPermission: allowPermission,
            executor: (request) => {
                started.resolve(request.signal);
                return new Promise<CommandExecutionResult>((resolve) => {
                    request.signal.addEventListener(
                        'abort',
                        () =>
                            resolve({
                                exitCode: null,
                                signal: 'SIGTERM',
                                timedOut: true,
                                stdout: '',
                                stderr: '',
                                durationMs: 120_000,
                            }),
                        { once: true },
                    );
                });
            },
        });

        // When
        const pending = invokeCommand(registry);
        const signal = await started.promise;
        await vi.advanceTimersByTimeAsync(119_999);

        // Then
        expect(signal.aborted).toBe(false);

        // When
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;

        // Then
        expect(signal.aborted).toBe(true);
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('command_timed_out');
    });

    it('defaults file.patch payload cap to 256 KiB', () => {
        // Given / When
        const options = resolveFilePatchOptions({
            workspaceRoot: '/workspace',
            requestPermission: allowPermission,
        });

        // Then
        expect(options.maxPatchBytes).toBe(256 * 1024);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

async function invokeCommand(registry: ToolRegistry) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'command.run');
    if (advertisement === undefined) {
        throw new TypeError('missing command.run advertisement');
    }
    return registry.invoke({
        toolCallId: 'command_default_call',
        toolName: 'command.run',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ command: 'node', args: allowedHarnessArgs }),
    });
}

function deferred<Value>() {
    let resolve: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}
