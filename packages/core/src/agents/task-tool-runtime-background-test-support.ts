import type { AgentDefinition } from '@mission-control/protocol';
import { z } from 'zod';
import type { ChildSpawnRequest } from '../tools/task/task-tool';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import { AgentIndex } from './agent-registry';
import { AsyncJobManager } from './async-job-manager';
import { AgentLifecycleManager } from './lifecycle-manager';
import { RuntimeAgentRegistry } from './runtime-registry';
import type { TaskToolRuntimeServices } from './task-tool-runtime';
import { ConcreteTaskToolRuntime } from './task-tool-runtime';

type Empty = Record<string, never>;

const emptySchema = z.object({}).strict();

function makeTool(name: string, capabilityClasses: readonly string[]): ToolRegistration<Empty, Empty> {
    return {
        name,
        description: `Mock tool ${name}`,
        capabilityClasses,
        parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
        inputSchema: emptySchema,
        outputSchema: emptySchema,
        outputLimit: { maxModelOutputChars: 1000 },
        execute: async () => ({}),
    };
}

function makeAgent(name: string, spawns?: '*'): AgentDefinition {
    return {
        name,
        description: `${name} test agent`,
        systemPrompt: `You are the ${name} agent.`,
        source: 'bundled',
        ...(spawns === undefined ? {} : { spawns }),
    };
}

export function makeBackgroundRequest(sessionId: string): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'do the thing',
        loadSkills: [],
        childPermissions: [],
        subagentType: 'child-agent',
    };
}

export function makeTaskRuntimeServices(): TaskToolRuntimeServices {
    const runtimeRegistry = new RuntimeAgentRegistry();
    return {
        jobManager: new AsyncJobManager(4),
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        runtimeRegistry,
    };
}

export function buildRuntimeWithServices(
    services: TaskToolRuntimeServices,
    spawnImpl: (sessionId: string) => Promise<{ status: 'completed' | 'failed'; output: string }>,
): ConcreteTaskToolRuntime {
    const agentIndex = new AgentIndex();
    agentIndex.register(makeAgent('child-agent'));
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(makeTool('read', ['read']));
    parentRegistry.register(makeTool('task', ['subagent']));

    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry: parentRegistry,
        parentAgent: makeAgent('parent', '*'),
        spawnFn: async (context) => {
            const result = await spawnImpl(context.sessionId);
            return { sessionId: context.sessionId, status: result.status, output: result.output };
        },
        services,
        parentSessionId: 'parent-session',
    });
}

export function buildRuntimeWithoutServices(): ConcreteTaskToolRuntime {
    const agentIndex = new AgentIndex();
    agentIndex.register(makeAgent('child-agent'));
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(makeTool('read', ['read']));
    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry: parentRegistry,
        parentAgent: makeAgent('parent', '*'),
    });
}
