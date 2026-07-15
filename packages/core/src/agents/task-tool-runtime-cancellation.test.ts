import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { AgentIndex } from './agent-registry.js';
import { AsyncJobManager } from './async-job-manager.js';
import { AgentLifecycleManager } from './lifecycle-manager.js';
import { RuntimeAgentRegistry } from './runtime-registry.js';
import { ConcreteTaskToolRuntime, type TaskToolRuntimeServices } from './task-tool-runtime.js';

const CONTROL_EPOCH: SessionControlEpoch = {
    dbIdentity: 'a'.repeat(64),
    sessionId: 'session-parent',
    ownerId: 'owner-parent',
    ownerEpoch: 9,
};

describe('task runtime cancellation propagation', () => {
    it('forwards signal and epoch through foreground child spawn', async () => {
        const controller = new AbortController();
        let observedSignal: AbortSignal | undefined;
        let observedEpoch: SessionControlEpoch | undefined;
        const runtime = buildRuntime((context) => {
            observedSignal = context.signal;
            observedEpoch = context.controlEpoch;
            return Promise.resolve({ sessionId: context.sessionId, status: 'completed', output: 'done' });
        });

        await runtime.runChildSession(request('foreground', controller.signal));

        expect(observedSignal).toBe(controller.signal);
        expect(observedEpoch).toEqual(CONTROL_EPOCH);
    });

    it('forwards AsyncJobManager cancellation into the live child and waits for its settlement', async () => {
        const services = makeServices();
        let observedSignal: AbortSignal | undefined;
        const childStarted = deferred<void>();
        const runningRuntime = buildRuntime((context) => {
            observedSignal = context.signal;
            childStarted.resolve();
            return new Promise((resolve) => {
                context.signal.addEventListener(
                    'abort',
                    () => resolve({ sessionId: context.sessionId, status: 'failed', output: 'aborted' }),
                    { once: true },
                );
            });
        }, services);

        const handle = runningRuntime.startBackgroundSession(request('background', new AbortController().signal));
        await childStarted.promise;
        services.jobManager.cancelJob(handle.backgroundId, 'operator_aborted');
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(observedSignal?.aborted).toBe(true);
        expect(settled.status).toBe('cancelled');
        expect(settled.cancellationReason).toBe('operator_aborted');
    });
});

function buildRuntime(
    spawnFn: NonNullable<ConstructorParameters<typeof ConcreteTaskToolRuntime>[0]['spawnFn']>,
    services?: TaskToolRuntimeServices,
): ConcreteTaskToolRuntime {
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
        spawnFn,
        ...(services !== undefined ? { services } : {}),
    });
}

function makeServices(): TaskToolRuntimeServices {
    const runtimeRegistry = new RuntimeAgentRegistry();
    return {
        jobManager: new AsyncJobManager(),
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        runtimeRegistry,
    };
}

function request(sessionId: string, signal: AbortSignal): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'work',
        subagentType: 'child',
        loadSkills: [],
        childPermissions: [],
        signal,
        controlEpoch: CONTROL_EPOCH,
    };
}

function deferred<Value>(): { readonly promise: Promise<Value>; readonly resolve: (value: Value) => void } {
    let resolve: (value: Value) => void = () => undefined;
    const promise = new Promise<Value>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}
