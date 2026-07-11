import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type CommandExecutionResult, registerCommandRunTool } from './command-run.js';
import { executeCommand, executeCommandPipeline } from './command-run-executor.js';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry.js';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowedHarnessArgs = ['--eval', "console.log('mission-control command.run harness ok')"] as const;

describe('command.run interruption', () => {
    it('does not spawn when the low-level command request is already aborted', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-run-pre-abort-'));
        const missingExecutable = join(workspaceRoot, 'must-not-be-spawned');

        try {
            // When
            const result = await executeCommand({
                command: missingExecutable,
                args: [],
                cwd: workspaceRoot,
                signal: AbortSignal.abort(),
                maxOutputBytes: 1024,
            });

            // Then
            expect(result).toMatchObject({ exitCode: null, signal: null, timedOut: false });
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('does not spawn any pipeline stage when a later request is already aborted', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-pipeline-pre-abort-'));
        const live = new AbortController();
        try {
            const result = await executeCommandPipeline([
                {
                    command: join(workspaceRoot, 'must-not-spawn-first'),
                    args: [],
                    cwd: workspaceRoot,
                    signal: live.signal,
                    maxOutputBytes: 1024,
                },
                {
                    command: join(workspaceRoot, 'must-not-spawn-second'),
                    args: [],
                    cwd: workspaceRoot,
                    signal: AbortSignal.abort(),
                    maxOutputBytes: 1024,
                },
            ]);

            expect(result).toMatchObject({ exitCode: null, signal: null, timedOut: false });
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('aborts the running executor when the tool invocation signal is aborted', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-run-interrupt-'));
        const registry = new ToolRegistry();
        const controller = new AbortController();
        const started = deferred<AbortSignal>();
        const release = deferred<CommandExecutionResult>();
        let observedSignal: AbortSignal | undefined;
        await registerCommandRunTool(registry, {
            workspaceRoot,
            requestPermission: allowPermission,
            executor: (request) => {
                observedSignal = request.signal;
                started.resolve(request.signal);
                return release.promise;
            },
        });

        try {
            const pending = invokeCommand(registry, controller.signal);
            const requestSignal = await started.promise;

            // When
            controller.abort();
            await Promise.resolve();
            release.resolve(interruptedResult());
            const settlement = await pending;

            // Then
            expect(requestSignal).toBe(observedSignal);
            expect(requestSignal.aborted).toBe(true);
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error).toMatchObject({ code: 'operator_aborted', retryable: false });
            expect(settlement.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['command.started', 'command.failed', 'tool.failed']),
            );
            expect(settlement.events.map((event) => event.type)).not.toContain('tool.completed');
            expect(settlement.events.map((event) => event.type)).not.toContain('command.timed_out');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('closes the spawn-to-listener race and removes the direct abort listener and kill timer', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-listener-race-'));
        const marker = join(workspaceRoot, 'late-marker');
        const controller = new AbortController();
        const listenerCounts = abortListenerCounts(controller, true);
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        try {
            const result = await executeCommand({
                command: process.execPath,
                args: [
                    '--eval',
                    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 100)`,
                ],
                cwd: workspaceRoot,
                signal: controller.signal,
                maxOutputBytes: 1024,
            });
            await delay(150);

            expect(result.timedOut).toBe(true);
            expect(await exists(marker)).toBe(false);
            expect(listenerCounts()).toEqual({ added: 1, removed: 1 });
            expect(clearTimeoutSpy).toHaveBeenCalled();
        } finally {
            clearTimeoutSpy.mockRestore();
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('removes the direct abort listener when spawn emits an error', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-error-cleanup-'));
        const controller = new AbortController();
        const listenerCounts = abortListenerCounts(controller, false);
        try {
            await expect(
                executeCommand({
                    command: join(workspaceRoot, 'missing-command'),
                    args: [],
                    cwd: workspaceRoot,
                    signal: controller.signal,
                    maxOutputBytes: 1024,
                }),
            ).rejects.toThrow();
            expect(listenerCounts()).toEqual({ added: 1, removed: 1 });
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('aborts every child when a later pipeline stage signal aborts after startup', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-pipeline-live-abort-'));
        const first = new AbortController();
        const later = new AbortController();
        const firstCounts = abortListenerCounts(first, false);
        const laterCounts = abortListenerCounts(later, false);
        const firstStarted = join(workspaceRoot, 'first-started');
        const laterStarted = join(workspaceRoot, 'later-started');
        const firstMarker = join(workspaceRoot, 'first-marker');
        const laterMarker = join(workspaceRoot, 'later-marker');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        try {
            const pending = executeCommandPipeline([
                pipelineRequest(workspaceRoot, first.signal, firstStarted, firstMarker),
                pipelineRequest(workspaceRoot, later.signal, laterStarted, laterMarker),
            ]);
            await waitForFiles([firstStarted, laterStarted]);

            later.abort();
            const result = await pending;
            await delay(300);

            expect(result.timedOut).toBe(true);
            expect(await Promise.all([exists(firstMarker), exists(laterMarker)])).toEqual([false, false]);
            expect(firstCounts()).toEqual({ added: 1, removed: 1 });
            expect(laterCounts()).toEqual({ added: 1, removed: 1 });
            expect(clearTimeoutSpy).toHaveBeenCalled();
        } finally {
            clearTimeoutSpy.mockRestore();
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function interruptedResult(): CommandExecutionResult {
    return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
        stdout: 'partial output',
        stderr: '',
        durationMs: 1,
    };
}

function deferred<Value>() {
    let resolve: (value: Value) => void = () => {};
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

async function invokeCommand(registry: ToolRegistry, signal: AbortSignal): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'command.run');
    if (advertisement === undefined) {
        throw new TypeError('missing command.run advertisement');
    }
    return registry.invoke({
        toolCallId: 'command_call',
        toolName: 'command.run',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ command: 'node', args: allowedHarnessArgs }),
        signal,
    });
}

function abortListenerCounts(
    controller: AbortController,
    abortOnAdd: boolean,
): () => {
    readonly added: number;
    readonly removed: number;
} {
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    Object.defineProperties(signal, {
        addEventListener: {
            configurable: true,
            value: (...args: Parameters<AbortSignal['addEventListener']>) => {
                added += 1;
                if (abortOnAdd) controller.abort();
                add(...args);
            },
        },
        removeEventListener: {
            configurable: true,
            value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
                removed += 1;
                remove(...args);
            },
        },
    });
    return () => ({ added, removed });
}

function pipelineRequest(cwd: string, signal: AbortSignal, startedPath: string, markerPath: string) {
    return {
        command: process.execPath,
        args: [
            '--eval',
            `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(startedPath)},'started');setTimeout(()=>fs.writeFileSync(${JSON.stringify(markerPath)},'late'),200);setInterval(()=>{},1000)`,
        ],
        cwd,
        signal,
        maxOutputBytes: 1024,
    };
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await Promise.all(paths.map(exists))).every(Boolean)) return;
        await delay(5);
    }
    throw new Error(`timed out waiting for files: ${paths.join(', ')}`);
}

function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
