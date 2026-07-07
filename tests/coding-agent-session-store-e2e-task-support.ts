import type { AgentDefinition } from '@mission-control/protocol';
import {
    AgentIndex,
    AgentLifecycleManager,
    AsyncJobManager,
    ConcreteTaskToolRuntime,
    RuntimeAgentRegistry,
    type SqlAgentJobMirror,
    type TaskToolRuntimeServices,
} from '../packages/core/src/index.js';
import type { ChildSpawnRequest } from '../packages/core/src/tools/task/task-tool.js';
import { ToolRegistry } from '../packages/core/src/tools/tool-registry.js';

export type ForegroundChildWait = {
    readonly done: Promise<unknown>;
    readonly release: () => void;
};

export async function startForegroundChildWait(input: {
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly mirror: SqlAgentJobMirror;
}): Promise<ForegroundChildWait> {
    let releaseSpawn = (): void => undefined;
    let spawnStarted = (): void => undefined;
    const spawnStartedPromise = new Promise<void>((resolve) => {
        spawnStarted = resolve;
    });
    const childRuntime = buildTaskRuntime(input.parentSessionId, taskRuntimeServices(input.mirror), (sessionId) => {
        spawnStarted();
        return new Promise<{ status: 'completed'; output: string }>((complete) => {
            releaseSpawn = () => complete({ status: 'completed', output: `child done ${sessionId}` });
        });
    });
    const done = childRuntime.runChildSession(childRequest(input.childSessionId));
    await spawnStartedPromise;
    await input.mirror.flush();
    return { done, release: releaseSpawn };
}

function buildTaskRuntime(
    parentSessionId: string,
    services: TaskToolRuntimeServices,
    spawnImpl: (sessionId: string) => Promise<{ status: 'completed'; output: string }>,
): ConcreteTaskToolRuntime {
    const agentIndex = new AgentIndex();
    agentIndex.register(makeAgent());
    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry: new ToolRegistry(),
        parentAgent: {
            name: 'parent',
            description: 'Parent agent',
            systemPrompt: 'You are the parent.',
            source: 'bundled',
        },
        spawnFn: async (context) => {
            const result = await spawnImpl(context.sessionId);
            return { sessionId: context.sessionId, status: result.status, output: result.output };
        },
        services,
        parentSessionId,
    });
}

function taskRuntimeServices(mirror: SqlAgentJobMirror): TaskToolRuntimeServices {
    const runtimeRegistry = new RuntimeAgentRegistry({ mirror });
    return {
        jobManager: new AsyncJobManager(4, { mirror }),
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        runtimeRegistry,
        mirror,
    };
}

function childRequest(sessionId: string): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'do the thing',
        loadSkills: [],
        childPermissions: [],
        subagentType: 'child-agent',
    };
}

function makeAgent(): AgentDefinition {
    return {
        name: 'child-agent',
        description: 'Child test agent',
        systemPrompt: 'You are a child agent.',
        source: 'bundled',
    };
}
