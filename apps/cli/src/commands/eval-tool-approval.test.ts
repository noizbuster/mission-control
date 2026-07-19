import {
    type EvalInput,
    type EvalRunOptions,
    type EvalRunResult,
    PermissionSession,
    type ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import { noLspServers, toolOptions, trustedProjectTrustStore } from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type EvalRuntimeProbe = {
    created: number;
    closed: number;
    readonly runs: EvalRunOptions[];
};

describe('production eval approval gates', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('returns typed failure without creating an eval runtime when noninteractive approval is denied', async () => {
        const workspaceRoot = createWorkspace(tempRoots, 'mctrl-eval-deny-');
        const requests: PermissionRequest[] = [];
        const probe = runtimeProbe();
        const options = {
            workspaceRoot,
            requestPermission: async (request: PermissionRequest): Promise<PermissionDecision> => {
                requests.push(request);
                return { requestId: request.id, status: 'deny', reason: 'operator denied eval' };
            },
            enableTrustedBash: true,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            evalContextManagerFactory: recordingRuntimeFactory(probe),
        };
        const { registry } = await createNonInteractiveToolRegistry(options);

        const settlement = await invokeEval(registry, 'eval-denied', {
            cells: [{ language: 'py', code: 'print("must not run")' }],
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.permission?.kind).toBe('bash');
        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'tool_failed', message: expect.stringContaining('approval_denied') },
        });
        expect(probe.created).toBe(0);
        expect(probe.runs).toEqual([]);
    });

    it('returns typed failure without creating an eval runtime when interactive approval is cancelled', async () => {
        const workspaceRoot = createWorkspace(tempRoots, 'mctrl-eval-cancel-');
        const output = createBufferedChatOutput();
        const approvalPending = deferredApproval();
        const events: AgentEvent[] = [];
        const probe = runtimeProbe();
        const options = {
            ...toolOptions({ ...output.output, showApproval: approvalPending.resolve }, workspaceRoot),
            emitEvent: (event: AgentEvent) => events.push(event),
            enableTrustedBash: true,
            evalContextManagerFactory: recordingRuntimeFactory(probe),
        };
        const broker = createInteractiveApprovalBroker(options, approvalSession());
        const { registry } = await createInteractiveToolRegistry(options, broker);

        const invocation = invokeEval(registry, 'eval-cancelled', {
            cells: [{ language: 'js', code: 'process.exit(99)' }],
        });
        await approvalPending.promise;
        broker.cancel('operator cancelled eval approval');
        const settlement = await invocation;

        expect(events.filter((event) => event.type === 'approval.requested')).toHaveLength(1);
        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'tool_failed', message: expect.stringContaining('approval_denied') },
        });
        expect(probe.created).toBe(0);
        expect(probe.runs).toEqual([]);
    });

    it('requests approval once before executing every raw cell unchanged', async () => {
        const workspaceRoot = createWorkspace(tempRoots, 'mctrl-eval-allow-');
        const output = createBufferedChatOutput();
        const approvalPending = deferredApproval();
        const events: AgentEvent[] = [];
        const probe = runtimeProbe();
        const rawCells = [
            'secret = "eval-secret-value"\nprint(secret)',
            'const untouched = "eval-secret-value";\nconsole.log(untouched)',
        ] as const;
        const options = {
            ...toolOptions({ ...output.output, showApproval: approvalPending.resolve }, workspaceRoot),
            emitEvent: (event: AgentEvent) => events.push(event),
            enableTrustedBash: true,
            evalContextManagerFactory: recordingRuntimeFactory(probe),
        };
        const broker = createInteractiveApprovalBroker(options, approvalSession());
        const { registry } = await createInteractiveToolRegistry(options, broker);

        const invocation = invokeEval(registry, 'eval-allowed', {
            cells: [
                { language: 'py', code: rawCells[0] },
                { language: 'js', code: rawCells[1] },
            ],
        });
        await approvalPending.promise;
        expect(broker.hasPending()).toBe(true);
        broker.answer('once');
        const settlement = await invocation;

        expect(settlement.result.status).toBe('completed');
        expect(events.filter((event) => event.type === 'approval.requested')).toHaveLength(1);
        const permissionEvent = events.find((event) => event.type === 'permission.requested');
        expect(permissionEvent?.permissionRequest).toMatchObject({
            action: 'eval',
            permission: { kind: 'bash', patterns: ['eval'], workspaceRoot },
        });
        expect(permissionEvent?.permissionRequest?.reason.length).toBeLessThanOrEqual(160);
        expect(JSON.stringify(events)).not.toContain('eval-secret-value');
        expect(probe.created).toBe(1);
        expect(probe.runs.map((run) => run.code)).toEqual(rawCells);
        expect(probe.closed).toBe(1);
    });
});

function createWorkspace(roots: string[], prefix: string): string {
    const workspaceRoot = mkdtempSync(join(tmpdir(), prefix));
    roots.push(workspaceRoot);
    return workspaceRoot;
}

function runtimeProbe(): EvalRuntimeProbe {
    return { created: 0, closed: 0, runs: [] };
}

function approvalSession(): PermissionSession {
    return new PermissionSession({
        builtInRules: [{ permission: 'bash', pattern: '*', decision: 'ask' }],
    });
}

function recordingRuntimeFactory(probe: EvalRuntimeProbe) {
    return () => {
        probe.created += 1;
        return {
            runCode: async (options: EvalRunOptions): Promise<EvalRunResult> => {
                probe.runs.push(options);
                return { output: options.code, exitCode: 0, truncated: false, timedOut: false };
            },
            close: async (): Promise<void> => {
                probe.closed += 1;
            },
        };
    };
}

async function invokeEval(registry: ToolRegistry, toolCallId: string, input: EvalInput) {
    const advertisement = registry.advertise().find((tool) => tool.name === 'eval');
    if (advertisement === undefined) {
        throw new TypeError('eval tool was not registered in the trusted production registry');
    }
    return registry.invoke({
        toolCallId,
        toolName: 'eval',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

function deferredApproval(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    if (resolve === undefined) {
        throw new TypeError('approval deferred initialization failed');
    }
    return { promise, resolve };
}
