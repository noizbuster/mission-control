import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import { registerCommandRunTool } from './command-run.js';
import type { CommandExecutionRequest, CommandExecutionResult } from './command-run-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTROL_EPOCH: SessionControlEpoch = {
    dbIdentity: 'e'.repeat(64),
    sessionId: 'session-command',
    ownerId: 'owner-command',
    ownerEpoch: 7,
};

describe('command.run session-control propagation', () => {
    it('forwards the invocation signal and owner epoch to the real command executor seam', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-command-epoch-'));
        const registry = new ToolRegistry();
        const controller = new AbortController();
        let request: CommandExecutionRequest | undefined;
        await registerCommandRunTool(registry, {
            workspaceRoot,
            requestPermission: allowPermission,
            executor: (input) => {
                request = input;
                return Promise.resolve(successResult());
            },
        });

        try {
            const advertisement = registry.advertise().find((tool) => tool.name === 'command.run');
            if (advertisement === undefined) throw new Error('missing command.run');
            await registry.invoke({
                toolCallId: 'command-epoch',
                toolName: 'command.run',
                advertisedVersion: advertisement.version,
                argumentsJson: JSON.stringify({ command: 'node', args: ['--version'] }),
                signal: controller.signal,
                controlEpoch: CONTROL_EPOCH,
            });

            expect(request?.signal).toBeDefined();
            expect(request?.controlEpoch).toEqual(CONTROL_EPOCH);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow' };
}

function successResult(): CommandExecutionResult {
    return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
}
