import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createSessionControlCallbackFence,
    createSessionControlOperation,
    readSessionControlOperation,
} from '../runtime/session-control-operation.js';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createOperationTestRuntime,
} from '../runtime/session-control-operation-test-support.js';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { AgentIndex } from './agent-registry.js';
import { AsyncJobManager } from './async-job-manager.js';
import { AgentLifecycleManager } from './lifecycle-manager.js';
import { RuntimeAgentRegistry } from './runtime-registry.js';
import { ConcreteTaskToolRuntime } from './task-tool-runtime.js';

afterEach(cleanupOperationTestRuntimes);

describe('ConcreteTaskToolRuntime controlled writer invariant', () => {
    it('fails closed without a durable mirror and leaves registry and operation terminal state untouched', async () => {
        const db = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(db, 'owner-child-no-mirror', 1_000);
        const childSessionId = 'session-child-no-mirror';
        await createSessionControlOperation({
            runtime: db,
            lease,
            operationId: 'operation-child-no-mirror',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`subagent:${childSessionId}`],
            nowWallMs: 1_100,
        });
        const runtimeRegistry = new RuntimeAgentRegistry();
        const runtime = buildRuntime(runtimeRegistry);

        await expect(
            runtime.runChildSession(
                request(childSessionId, {
                    dbIdentity: lease.dbIdentity,
                    sessionId: lease.sessionId,
                    ownerId: lease.ownerId,
                    ownerEpoch: lease.epoch,
                    callbackFence: createSessionControlCallbackFence({
                        runtime: db,
                        lease,
                        operationId: 'operation-child-no-mirror',
                        nowWallMs: () => 1_200,
                    }),
                }),
            ),
        ).rejects.toThrow('durable mirror');

        expect(runtimeRegistry.lookup(childSessionId)?.status).toBe('running');
        expect(
            await readSessionControlOperation(db, lease.dbIdentity, lease.sessionId, 'operation-child-no-mirror'),
        ).toMatchObject({ settledHandleIds: [] });
        db.close();
    });
});

function buildRuntime(runtimeRegistry: RuntimeAgentRegistry): ConcreteTaskToolRuntime {
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
        spawnFn: async (context) => ({ sessionId: context.sessionId, status: 'completed', output: 'done' }),
        services: {
            jobManager: new AsyncJobManager(),
            lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
            runtimeRegistry,
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
