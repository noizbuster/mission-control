import type { AgentDefinition, PolicyEffectRule } from '@mission-control/protocol';
import { z } from 'zod';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistration } from '../tools/tool-registry-types.js';
import { AgentIndex } from './agent-registry.js';
import type { ChildSpawnContext, SpawnFn } from './task-tool-runtime.js';
import { ConcreteTaskToolRuntime } from './task-tool-runtime.js';

type ToolInput = Readonly<Record<string, unknown>>;
type ToolOutput = { readonly ok: true };

const toolInputSchema = z.record(z.string(), z.unknown());
export const toolOutputSchema = z.object({ ok: z.literal(true) }).strict();
export const allowAllChildPermissions: readonly PolicyEffectRule[] = [{ action: '*', resource: '**', effect: 'allow' }];

export function makePermissionTool(
    name: string,
    capabilityClasses: readonly string[],
    executed: { value: number },
): ToolRegistration<ToolInput, ToolOutput> {
    return {
        name,
        description: `Test ${name}`,
        capabilityClasses,
        parametersJsonSchema: { type: 'object' },
        inputSchema: toolInputSchema,
        outputSchema: toolOutputSchema,
        outputLimit: { maxModelOutputChars: 100 },
        execute: async () => {
            executed.value += 1;
            return { ok: true };
        },
    };
}

export function makePermissionAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        name: 'child-agent',
        description: 'Child test agent',
        systemPrompt: 'Act as a child agent.',
        source: 'bundled',
        ...overrides,
    };
}

export function makePermissionRequest(childPermissions: readonly PolicyEffectRule[]): ChildSpawnRequest {
    return {
        sessionId: 'session-child',
        prompt: 'perform the delegated task',
        loadSkills: [],
        childPermissions,
        subagentType: 'child-agent',
    };
}

export function buildPermissionRuntime(
    childAgent: AgentDefinition = makePermissionAgent(),
    parentAgent: AgentDefinition = makePermissionAgent({ name: 'parent-agent', spawns: '*' }),
): {
    readonly runtime: ConcreteTaskToolRuntime;
    readonly contexts: ChildSpawnContext[];
    readonly executed: { value: number };
    readonly parentToolRegistry: ToolRegistry;
} {
    const agentIndex = new AgentIndex();
    agentIndex.register(childAgent);
    const executed = { value: 0 };
    const parentToolRegistry = new ToolRegistry();
    for (const [name, capabilityClasses] of [
        ['repo.read', ['repo.read']],
        ['read', ['read']],
        ['file.write', ['file.write']],
        ['file.patch', ['file.patch']],
        ['bash.run', ['bash.run']],
        ['command.run', ['command.run']],
        ['webfetch', ['network']],
        ['local-cache', ['network-cache']],
        ['task', ['subagent']],
        ['job', ['subagent']],
        ['workflow', ['workflow']],
        ['team_create', ['team']],
        ['coordinate', ['coordination']],
    ] satisfies readonly (readonly [string, readonly string[]])[]) {
        parentToolRegistry.register(makePermissionTool(name, capabilityClasses, executed));
    }
    const contexts: ChildSpawnContext[] = [];
    const spawnFn: SpawnFn = async (context) => {
        contexts.push(context);
        return { sessionId: context.sessionId, status: 'completed', output: 'complete' };
    };
    return {
        runtime: new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: () => ({ providerID: 'test', modelID: 'test-model' }),
            workspaceRoot: '/tmp/workspace',
            parentToolRegistry,
            parentAgent,
            spawnFn,
        }),
        contexts,
        executed,
        parentToolRegistry,
    };
}

export function advertisedChildToolNames(context: ChildSpawnContext | undefined): readonly string[] {
    return context?.childToolRegistry.advertise().map((tool) => tool.name) ?? [];
}
