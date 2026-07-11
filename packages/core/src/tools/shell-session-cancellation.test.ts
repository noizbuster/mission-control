import type { PermissionDecision, PermissionRequest, SidecarStreamFrame } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import type { ShellSessionTransport, ShellSessionTransportRequest } from './shell-session.js';
import { registerShellSessionTool } from './shell-session.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTROL_EPOCH: SessionControlEpoch = {
    dbIdentity: 'f'.repeat(64),
    sessionId: 'session-shell',
    ownerId: 'owner-shell',
    ownerEpoch: 4,
};

describe('shell.session cancellation propagation', () => {
    it('waits for cooperative sidecar settlement and preserves failed tool semantics', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-shell-cancel-'));
        const controller = new AbortController();
        let observed: ShellSessionTransportRequest | undefined;
        let sidecarSettled = false;
        const transport: ShellSessionTransport = {
            openSession: (request) => {
                observed = request;
                return new Promise<readonly SidecarStreamFrame[]>((resolve) => {
                    request.signal.addEventListener(
                        'abort',
                        () => {
                            sidecarSettled = true;
                            resolve([
                                { sessionId: request.sessionId, seq: 0, payload: '', end: true, error: 'interrupted' },
                            ]);
                        },
                        { once: true },
                    );
                });
            },
        };
        const registry = await registryFor(workspaceRoot, transport, 200);

        try {
            const pending = invokeShell(registry, controller.signal, CONTROL_EPOCH);
            await waitFor(() => observed !== undefined);
            controller.abort();
            const settlement = await pending;

            expect(observed?.controlEpoch).toEqual(CONTROL_EPOCH);
            expect(sidecarSettled).toBe(true);
            expect(settlement.result.status).toBe('failed');
            expect(settlement.events.map((event) => event.type)).not.toContain('tool.completed');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('truthfully times out when a noncooperative sidecar ignores cancellation', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-shell-timeout-'));
        const controller = new AbortController();
        let opened = false;
        const transport: ShellSessionTransport = {
            openSession: () => {
                opened = true;
                return new Promise(() => undefined);
            },
        };
        const registry = await registryFor(workspaceRoot, transport, 20);

        try {
            const pending = invokeShell(registry, controller.signal, CONTROL_EPOCH);
            await waitFor(() => opened);
            controller.abort();
            const settlement = await pending;
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('command_timed_out');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

async function registryFor(
    workspaceRoot: string,
    transport: ShellSessionTransport,
    timeoutMs: number,
): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerShellSessionTool(registry, {
        workspaceRoot,
        workspaceTrust: 'trusted',
        requestPermission: allowPermission,
        transport,
        timeoutMs,
    });
    return registry;
}

function invokeShell(registry: ToolRegistry, signal: AbortSignal, controlEpoch: SessionControlEpoch) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'shell.session');
    if (advertisement === undefined) throw new Error('missing shell.session');
    return registry.invoke({
        toolCallId: 'shell-cancel',
        toolName: 'shell.session',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ commandLine: 'sleep 30', sessionId: 'controlled-shell' }),
        signal,
        controlEpoch,
    });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow' };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 1));
}
