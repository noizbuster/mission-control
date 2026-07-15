import type { AgentDefinition, PolicyEffectRule } from '@mission-control/protocol';
import { JOB_TOOL_NAME } from '../tools/job-tool.js';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { TASK_TOOL_NAME } from '../tools/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutionError } from '../tools/tool-registry-types.js';
import { createYieldToolRegistration } from '../tools/yield-tool/yield-tool.js';
import type { AgentIndex } from './agent-registry.js';
import { hasHardDroppedCapability } from './child-graph-spawn.js';
import {
    createChildToolInvocationPolicy,
    isCategoryToolAllowed,
    isToolDeniedForEveryResource,
} from './child-tool-permissions.js';
import type { ModelPattern } from './model-resolver.js';
import { deriveChildPathPolicies } from './path-policy-derive.js';
import { canSpawn } from './spawn-policy.js';
import { buildChildSystemPrompt } from './spawn-prompt-builder.js';
import { createHash } from 'node:crypto';

export type PreparedChildSpawnAuthority = {
    readonly agent: AgentDefinition;
    readonly model: ModelPattern;
    readonly systemPrompt: string;
    readonly childToolRegistry: ToolRegistry;
    readonly authorityFingerprint: string;
};

export function lookupChildAgent(agentIndex: AgentIndex, request: ChildSpawnRequest): AgentDefinition {
    if (request.subagentType !== undefined) {
        const agent = agentIndex.lookup(request.subagentType);
        if (agent === undefined) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `unknown agent: ${request.subagentType}`,
                retryable: false,
            });
        }
        return agent;
    }
    const fallbackKey = request.category?.id;
    if (fallbackKey !== undefined) {
        const agent = agentIndex.lookup(fallbackKey);
        if (agent !== undefined) return agent;
    }
    throw new ToolExecutionError({
        code: 'tool_failed',
        message: 'no agent resolved for child session (provide subagentType or a known category)',
        retryable: false,
    });
}

export function buildChildToolSurface(input: {
    readonly parentToolRegistry: ToolRegistry;
    readonly parentAgent: AgentDefinition;
    readonly child: AgentDefinition;
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly categoryTools: readonly string[] | undefined;
    readonly workspaceRoot: string;
}): ToolRegistry {
    const pathPolicies = deriveChildPathPolicies(input.parentAgent, input.child);
    const ruleGroups = [pathPolicies, input.childPermissions];
    const registry = input.parentToolRegistry.cloneWithFilter(
        (advertisement) =>
            isCategoryToolAllowed(advertisement.name, input.child.tools) &&
            isCategoryToolAllowed(advertisement.name, input.categoryTools) &&
            advertisement.name !== TASK_TOOL_NAME &&
            advertisement.name !== JOB_TOOL_NAME &&
            !hasHardDroppedCapability(advertisement.capabilityClasses) &&
            !isToolDeniedForEveryResource(advertisement, ruleGroups),
        createChildToolInvocationPolicy(ruleGroups, input.workspaceRoot),
    );
    registry.register(createYieldToolRegistration({}));
    return registry;
}

export function assertAgentSpawnAllowed(input: {
    readonly agentIndex: AgentIndex;
    readonly parentAgent: AgentDefinition;
    readonly parentSessionId: string;
    readonly request: ChildSpawnRequest;
}): void {
    const agent = lookupChildAgent(input.agentIndex, input.request);
    const decision = canSpawn(input.parentAgent, agent.name, {
        parentId: input.parentSessionId,
        childId: input.request.sessionId,
    });
    if (decision.allowed) return;
    throw new ToolExecutionError({ code: 'tool_failed', message: decision.reason, retryable: false });
}

export function childAuthorityFingerprint(input: {
    readonly parentToolRegistry: ToolRegistry;
    readonly parentAgent: AgentDefinition;
    readonly parentSessionId: string;
    readonly workspaceRoot: string;
    readonly request: ChildSpawnRequest;
    readonly agent: AgentDefinition;
    readonly model: ModelPattern;
    readonly systemPrompt: string;
    readonly childToolRegistry: ToolRegistry;
}): string {
    const canonicalAuthority = canonicalJson({
        parentSessionId: input.parentSessionId,
        workspaceRoot: input.workspaceRoot,
        parentSpawns: canonicalStringSet(input.parentAgent.spawns),
        parentPathPolicies: input.parentAgent.pathPolicies ?? null,
        parentTools: canonicalToolAdvertisements(input.parentToolRegistry),
        agentName: input.agent.name,
        agentTools: canonicalStringSet(input.agent.tools),
        agentPathPolicies: input.agent.pathPolicies ?? null,
        categoryId: input.request.category?.id ?? null,
        categoryTools: canonicalStringSet(input.request.category?.tools),
        childPermissions: input.request.childPermissions,
        model: {
            providerID: input.model.providerID,
            modelID: input.model.modelID,
            variantID: input.model.variantID ?? null,
        },
        systemPrompt: input.systemPrompt,
        childTools: canonicalToolAdvertisements(input.childToolRegistry),
    });
    return `sha256:${createHash('sha256').update(canonicalAuthority, 'utf8').digest('hex')}`;
}

export function prepareChildSpawnAuthority(input: {
    readonly agentIndex: AgentIndex;
    readonly resolveModel: (agent: AgentDefinition) => ModelPattern;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentAgent: AgentDefinition;
    readonly parentSessionId: string;
    readonly workspaceRoot: string;
    readonly request: ChildSpawnRequest;
}): PreparedChildSpawnAuthority {
    const agent = lookupChildAgent(input.agentIndex, input.request);
    const model = input.resolveModel(agent);
    const systemPrompt = buildChildSystemPrompt({
        agent,
        ...(agent.role !== undefined ? { role: agent.role } : {}),
    });
    const childToolRegistry = buildChildToolSurface({
        parentToolRegistry: input.parentToolRegistry,
        parentAgent: input.parentAgent,
        child: agent,
        childPermissions: input.request.childPermissions,
        categoryTools: input.request.category?.tools,
        workspaceRoot: input.workspaceRoot,
    });
    return {
        agent,
        model,
        systemPrompt,
        childToolRegistry,
        authorityFingerprint: childAuthorityFingerprint({ ...input, agent, model, systemPrompt, childToolRegistry }),
    };
}

function canonicalStringSet(values: readonly string[] | '*' | undefined): readonly string[] | '*' | null {
    if (values === undefined) return null;
    return values === '*' ? values : [...values].sort(compareCanonicalStrings);
}

function canonicalToolAdvertisements(registry: ToolRegistry): readonly {
    readonly name: string;
    readonly version: string;
    readonly capabilityClasses: readonly string[];
}[] {
    return registry
        .advertise()
        .map((tool) => ({
            name: tool.name,
            version: tool.version,
            capabilityClasses: [...tool.capabilityClasses].sort(),
        }))
        .sort((left, right) => compareCanonicalStrings(left.name, right.name));
}

function canonicalJson(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value).sort(([left], [right]) => compareCanonicalStrings(left, right));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function compareCanonicalStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

export function childDisplayName(request: ChildSpawnRequest): string {
    return request.subagentType ?? request.category?.id ?? request.sessionId;
}

export function childResumeError(sessionId: string, reason: string): ToolExecutionError {
    return new ToolExecutionError({
        code: 'tool_failed',
        message: `cannot resume child ${sessionId}: ${reason}`,
        retryable: false,
    });
}
