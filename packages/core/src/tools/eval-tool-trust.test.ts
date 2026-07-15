import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ProjectTrustDecision, ProjectTrustReader } from '../trust/project-trust-store';
import type { EvalRunOptions, EvalRunResult } from './eval-context-manager';
import type { EvalInput } from './eval-schemas';
import { createEvalToolRegistration, type EvalContextManagerFactory } from './eval-tool';
import { ToolExecutionError } from './tool-registry-types';

type RuntimeProbe = {
    created: number;
    closed: number;
    readonly runs: EvalRunOptions[];
};

const evalInput: EvalInput = {
    cells: [{ language: 'js', code: 'console.log("trusted")' }],
};

describe('public eval factory workspace trust authority', () => {
    it('rejects denied workspace trust before permission or runtime creation', async () => {
        const permissionRequests: PermissionRequest[] = [];
        const trustLookups: string[] = [];
        const runtime = runtimeProbe();
        const registration = createEvalToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: trustReader(['denied'], trustLookups),
            requestPermission: async (request) => {
                permissionRequests.push(request);
                return allow(request);
            },
            contextManagerFactory: recordingRuntimeFactory(runtime),
        });

        await expect(registration.execute(evalInput, toolContext())).rejects.toBeInstanceOf(ToolExecutionError);

        expect(trustLookups).toEqual(['/workspace']);
        expect(permissionRequests).toEqual([]);
        expect(runtime.created).toBe(0);
        expect(runtime.runs).toEqual([]);
    });

    it('fails closed when the canonical trust lookup rejects', async () => {
        const permissionRequests: PermissionRequest[] = [];
        const runtime = runtimeProbe();
        const registration = createEvalToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: {
                getDecision: async () => {
                    throw new TypeError('trust store unavailable');
                },
            },
            requestPermission: async (request) => {
                permissionRequests.push(request);
                return allow(request);
            },
            contextManagerFactory: recordingRuntimeFactory(runtime),
        });

        await expect(registration.execute(evalInput, toolContext())).rejects.toBeInstanceOf(ToolExecutionError);

        expect(permissionRequests).toEqual([]);
        expect(runtime.created).toBe(0);
    });

    it('rechecks trust after approval and blocks a revoked workspace before runtime creation', async () => {
        const permissionRequests: PermissionRequest[] = [];
        const trustLookups: string[] = [];
        const runtime = runtimeProbe();
        const registration = createEvalToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: trustReader(['trusted', 'denied'], trustLookups),
            requestPermission: async (request) => {
                permissionRequests.push(request);
                return allow(request);
            },
            contextManagerFactory: recordingRuntimeFactory(runtime),
        });

        await expect(registration.execute(evalInput, toolContext())).rejects.toBeInstanceOf(ToolExecutionError);

        expect(trustLookups).toEqual(['/workspace', '/workspace']);
        expect(permissionRequests).toHaveLength(1);
        expect(runtime.created).toBe(0);
    });

    it('executes with an explicit trusted authority and approval without spawning a real process', async () => {
        const trustLookups: string[] = [];
        const runtime = runtimeProbe();
        const registration = createEvalToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: trustReader(['trusted', 'trusted'], trustLookups),
            requestPermission: async (request) => allow(request),
            contextManagerFactory: recordingRuntimeFactory(runtime),
        });

        const result = await registration.execute(evalInput, toolContext());

        expect(trustLookups).toEqual(['/workspace', '/workspace']);
        expect(result.results[0]?.output).toBe('console.log("trusted")');
        expect(runtime.created).toBe(1);
        expect(runtime.runs).toHaveLength(1);
        expect(runtime.closed).toBe(1);
    });

    it('does not create a runtime when cancellation arrives during approval', async () => {
        const controller = new AbortController();
        const trustLookups: string[] = [];
        const runtime = runtimeProbe();
        const registration = createEvalToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: trustReader(['trusted', 'trusted'], trustLookups),
            requestPermission: async (request) => {
                controller.abort();
                return allow(request);
            },
            contextManagerFactory: recordingRuntimeFactory(runtime),
        });

        await expect(registration.execute(evalInput, toolContext(controller.signal))).rejects.toMatchObject({
            error: { code: 'operator_aborted' },
        });

        expect(trustLookups).toEqual(['/workspace', '/workspace']);
        expect(runtime.created).toBe(0);
        expect(runtime.runs).toEqual([]);
    });
});

function trustReader(decisions: readonly ProjectTrustDecision[], lookups: string[]): ProjectTrustReader {
    let index = 0;
    return {
        getDecision: async (workspaceRoot) => {
            lookups.push(workspaceRoot);
            const decision = decisions[Math.min(index, decisions.length - 1)] ?? 'unknown';
            index += 1;
            return {
                decision,
                workspaceRoot,
                filePath: '/test/trust/projects.json',
                storeState: 'valid',
            };
        },
    };
}

function runtimeProbe(): RuntimeProbe {
    return { created: 0, closed: 0, runs: [] };
}

function recordingRuntimeFactory(probe: RuntimeProbe): EvalContextManagerFactory {
    return () => {
        probe.created += 1;
        return {
            runCode: async (options: EvalRunOptions): Promise<EvalRunResult> => {
                probe.runs.push(options);
                return { output: options.code, exitCode: 0, truncated: false, timedOut: false };
            },
            close: async () => {
                probe.closed += 1;
            },
        };
    };
}

function allow(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'explicit test approval' };
}

function toolContext(signal: AbortSignal = new AbortController().signal) {
    return { toolCallId: 'eval-trust-test', toolName: 'eval', signal };
}
