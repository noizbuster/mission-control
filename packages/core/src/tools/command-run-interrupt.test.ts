import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { type CommandExecutionResult, registerCommandRunTool } from './command-run.js';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowedHarnessArgs = ['--eval', "console.log('mission-control command.run harness ok')"] as const;

describe('command.run interruption', () => {
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
            expect(settlement.result.error?.message).toContain('command_failed');
            expect(settlement.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['command.started', 'command.failed', 'tool.failed']),
            );
            expect(settlement.events.map((event) => event.type)).not.toContain('tool.completed');
            expect(settlement.events.map((event) => event.type)).not.toContain('command.timed_out');
        } finally {
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
