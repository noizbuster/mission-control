import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { expireSessionControlLease } from '../runtime/session-control-lease';
import {
    createSessionControlCallbackFence,
    createSessionControlOperation,
} from '../runtime/session-control-operation';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createOperationTestRuntime,
} from '../runtime/session-control-operation-test-support';
import type { ChildSpawnRequest } from '../tools/task/task-tool';
import { ToolRegistry } from '../tools/tool-registry';
import { SqlAgentJobMirror } from './agent-job-sql-mirror';
import { AgentIndex } from './agent-registry';
import { AsyncJobManager } from './async-job-manager';
import { AgentLifecycleManager } from './lifecycle-manager';
import { RuntimeAgentRegistry } from './runtime-registry';
import { ConcreteTaskToolRuntime } from './task-tool-runtime';
import { QuarantinedChildSettlementError } from './task-tool-runtime-control';

afterEach(cleanupOperationTestRuntimes);

describe('ConcreteTaskToolRuntime callback fencing', () => {
    it('quarantines stale child completion before registry and durable wait mutation', async () => {
        const db = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(db, 'owner-child-old', 1_000);
        const mirror = await SqlAgentJobMirror.create(db);
        const runtimeRegistry = new RuntimeAgentRegistry({ mirror });
        let release: ((result: { sessionId: string; status: 'completed'; output: string }) => void) | undefined;
        let spawnStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            spawnStarted = resolve;
        });
        const runtime = buildRuntime({
            parentSessionId: oldLease.sessionId,
            runtimeRegistry,
            mirror,
            spawnFn: (_context) => {
                spawnStarted?.();
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
        });
        const childSessionId = 'session-child-stale';
        await createSessionControlOperation({
            runtime: db,
            lease: oldLease,
            operationId: 'operation-child-stale',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`subagent:${childSessionId}`],
            nowWallMs: 1_100,
        });
        const childResult = runtime.runChildSession(
            request(childSessionId, {
                dbIdentity: oldLease.dbIdentity,
                sessionId: oldLease.sessionId,
                ownerId: oldLease.ownerId,
                ownerEpoch: oldLease.epoch,
                callbackFence: createSessionControlCallbackFence({
                    runtime: db,
                    lease: oldLease,
                    operationId: 'operation-child-stale',
                    nowWallMs: () => 2_100,
                }),
            }),
        );
        await started;
        await expireSessionControlLease({ runtime: db, lease: oldLease, nowWallMs: 2_000 });
        await acquireOperationTestLease(db, 'owner-child-new', 2_000);

        release?.({ sessionId: childSessionId, status: 'completed', output: 'late' });
        await expect(childResult).rejects.toBeInstanceOf(QuarantinedChildSettlementError);
        await mirror.flush();

        expect(runtimeRegistry.lookup(childSessionId)?.status).toBe('running');
        expect(await mirror.loadPendingWaits(oldLease.sessionId)).toHaveLength(1);
        db.close();
    });
});

function buildRuntime(input: {
    readonly parentSessionId: string;
    readonly runtimeRegistry: RuntimeAgentRegistry;
    readonly mirror: SqlAgentJobMirror;
    readonly spawnFn: NonNullable<ConstructorParameters<typeof ConcreteTaskToolRuntime>[0]['spawnFn']>;
}): ConcreteTaskToolRuntime {
    const child: AgentDefinition = {
        name: 'child',
        description: 'child',
        systemPrompt: 'child',
        source: 'bundled',
    };
    const parent: AgentDefinition = {
        name: 'parent',
        description: 'parent',
        systemPrompt: 'parent',
        source: 'bundled',
        spawns: '*',
    };
    const index = new AgentIndex();
    index.register(child);
    return new ConcreteTaskToolRuntime({
        agentIndex: index,
        resolveModel: () => ({ providerID: 'test', modelID: 'test' }),
        workspaceRoot: '/tmp',
        parentToolRegistry: new ToolRegistry(),
        parentAgent: parent,
        parentSessionId: input.parentSessionId,
        isCliRootParent: true,
        spawnFn: input.spawnFn,
        services: {
            jobManager: new AsyncJobManager(),
            lifecycleManager: new AgentLifecycleManager(input.runtimeRegistry),
            runtimeRegistry: input.runtimeRegistry,
            mirror: input.mirror,
        },
    });
}

function request(sessionId: string, controlEpoch: NonNullable<ChildSpawnRequest['controlEpoch']>): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'work',
        subagentType: 'child',
        loadSkills: [],
        childPermissions: [],
        controlEpoch,
    };
}
