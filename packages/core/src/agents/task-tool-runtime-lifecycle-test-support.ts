import type { AgentDefinition } from '@mission-control/protocol';
import {
    cleanupSessionOwnerControlFixtures,
    createSessionOwnerControlFixture,
} from '../runtime/session-owner-control-test-support';
import type { ChildSpawnRequest } from '../tools/task/task-tool';
import { ToolRegistry } from '../tools/tool-registry';
import { AgentIndex } from './agent-registry';
import { AsyncJobManager, type AsyncJobPersistenceMirror } from './async-job-manager';
import { AgentLifecycleManager } from './lifecycle-manager';
import { RuntimeAgentRegistry } from './runtime-registry';
import {
    ConcreteTaskToolRuntime,
    type SpawnFn,
    type TaskToolRuntimeServices,
    type TaskToolSubagentMirror,
} from './task-tool-runtime';

type OwnerFixture = Awaited<ReturnType<typeof createSessionOwnerControlFixture>>;

const fixtures: OwnerFixture[] = [];

export async function createLifecycleHost(sessionId: string): Promise<OwnerFixture> {
    const fixture = await createSessionOwnerControlFixture(sessionId);
    await fixture.host.release(sessionId);
    fixtures.push(fixture);
    return fixture;
}

export async function cleanupLifecycleHosts(): Promise<void> {
    const active = fixtures.splice(0);
    await Promise.all(active.map((fixture) => fixture.close()));
    await cleanupSessionOwnerControlFixtures();
}

export function makeLifecycleServices(input: {
    readonly host: OwnerFixture['host'];
    readonly runtimeRegistry?: RuntimeAgentRegistry;
    readonly mirror?: TaskToolSubagentMirror;
    readonly jobMirror?: AsyncJobPersistenceMirror;
    readonly maxConcurrency?: number;
    readonly controlJobs?: boolean;
}): TaskToolRuntimeServices {
    const runtimeRegistry = input.runtimeRegistry ?? new RuntimeAgentRegistry();
    return {
        jobManager: new AsyncJobManager(input.maxConcurrency ?? 4, {
            ...(input.jobMirror === undefined ? {} : { mirror: input.jobMirror }),
            ...(input.controlJobs === true ? { sessionControlHost: input.host } : {}),
        }),
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        runtimeRegistry,
        sessionControlHost: input.host,
        ...(input.mirror === undefined ? {} : { mirror: input.mirror }),
    };
}

export function buildLifecycleRuntime(services: TaskToolRuntimeServices, spawnFn: SpawnFn): ConcreteTaskToolRuntime {
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
    const agentIndex = new AgentIndex();
    agentIndex.register(child);
    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: () => ({ providerID: 'test', modelID: 'test' }),
        workspaceRoot: '/tmp',
        parentToolRegistry: new ToolRegistry(),
        parentAgent: parent,
        parentSessionId: 'parent-session',
        isCliRootParent: true,
        spawnFn,
        services,
    });
}

export function lifecycleRequest(
    sessionId: string,
    signal?: AbortSignal,
    controlEpoch?: ChildSpawnRequest['controlEpoch'],
): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'work',
        subagentType: 'child',
        loadSkills: [],
        childPermissions: [],
        ...(signal === undefined ? {} : { signal }),
        ...(controlEpoch === undefined ? {} : { controlEpoch }),
    };
}

export function resolvingMirror(overrides: Partial<TaskToolSubagentMirror> = {}): TaskToolSubagentMirror {
    return {
        startSubagentWait: async () => undefined,
        resolveSubagentWait: async () => undefined,
        ...overrides,
    };
}

export function abortListenerCounts(controller: AbortController): () => {
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
