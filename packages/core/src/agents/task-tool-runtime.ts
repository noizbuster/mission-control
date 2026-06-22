/**
 * Concrete {@linkcode TaskToolRuntime} — bridges the full-parity `task()` tool
 * to real agent resolution, model resolution, child system-prompt assembly,
 * and child tool-surface construction.
 *
 * This runtime is the single place where the task tool's abstract spawn
 * contract meets the agent discovery index, the model resolver, the
 * yield tool, and the existing permission rule algebra. The actual graph
 * execution (runAbgGraph) is delegated to an injected `spawnFn` so tests
 * can mock everything; the default spawn fn throws `not_yet_implemented`
 * until the CLI wiring (todo 25) connects a real graph runner.
 *
 * Safety: the child tool surface always drops the `task` tool (registry-layer
 * recursion guard, ABG section 10.6), adds the `yield` tool (child result
 * submission), and removes tools whose capability classes are globally denied
 * by the derived path policies.
 */

import type { AgentDefinition, PolicyEffectRule } from '@mission-control/protocol';
import type { ChildSpawnRequest, ChildSpawnResult, TaskToolRuntime } from '../tools/task/task-tool.js';
import { TASK_TOOL_NAME } from '../tools/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutionError } from '../tools/tool-registry-types.js';
import { createYieldToolRegistration } from '../tools/yield-tool/yield-tool.js';
import type { AgentIndex } from './agent-registry.js';
import { type ModelPattern } from './model-resolver.js';
import { deriveChildPathPolicies, evaluatePathPolicies } from './path-policy-derive.js';
import { getRuntimeRegistry } from './runtime-registry.js';
import { buildChildSystemPrompt } from './spawn-prompt-builder.js';
import { randomBytes } from 'node:crypto';

/** Resolves an agent's active model. Caller captures session defaults and role config. */
export type ResolveAgentModelFn = (agent: AgentDefinition) => ModelPattern;

/** Fully-resolved context passed to the spawn function. */
export interface ChildSpawnContext {
    readonly sessionId: string;
    readonly prompt: string;
    readonly agent: AgentDefinition;
    readonly model: ModelPattern;
    readonly systemPrompt: string;
    readonly childToolRegistry: ToolRegistry;
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly workspaceRoot: string;
}

/** Builds and runs the child graph from a resolved context. */
export type SpawnFn = (context: ChildSpawnContext) => Promise<ChildSpawnResult>;

export interface ConcreteTaskToolRuntimeOptions {
    readonly agentIndex: AgentIndex;
    readonly resolveModel: ResolveAgentModelFn;
    readonly workspaceRoot: string;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentAgent: AgentDefinition;
    readonly spawnFn?: SpawnFn;
}

const NOT_YET_IMPLEMENTED = 'startBackgroundSession: AsyncJobManager not yet implemented (todo 23)';

function defaultSpawnFn(context: ChildSpawnContext): Promise<ChildSpawnResult> {
    void context;
    return Promise.reject(new Error('spawnFn not wired: real graph runner is todo 25'));
}

export class ConcreteTaskToolRuntime implements TaskToolRuntime {
    private readonly agentIndex: AgentIndex;
    private readonly resolveModelFn: ResolveAgentModelFn;
    private readonly workspaceRoot: string;
    private readonly parentToolRegistry: ToolRegistry;
    private readonly parentAgent: AgentDefinition;
    private readonly spawnFn: SpawnFn;

    constructor(options: ConcreteTaskToolRuntimeOptions) {
        this.agentIndex = options.agentIndex;
        this.resolveModelFn = options.resolveModel;
        this.workspaceRoot = options.workspaceRoot;
        this.parentToolRegistry = options.parentToolRegistry;
        this.parentAgent = options.parentAgent;
        this.spawnFn = options.spawnFn ?? defaultSpawnFn;
    }

    async runChildSession(request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        return this.executeSpawn(request.sessionId, request);
    }

    startBackgroundSession(_request: ChildSpawnRequest): never {
        void _request;
        throw new Error(NOT_YET_IMPLEMENTED);
    }

    async resumeChildSession(sessionId: string, request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        return this.executeSpawn(sessionId, request);
    }

    sessionExists(sessionId: string): boolean {
        return getRuntimeRegistry().lookup(sessionId) !== undefined;
    }

    generateSessionId(): string {
        return `session_${Date.now()}_${randomBytes(4).toString('hex')}`;
    }

    private async executeSpawn(sessionId: string, request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        const agent = this.lookupAgent(request);
        const model = this.resolveModelFn(agent);
        const systemPrompt = buildChildSystemPrompt({
            agent,
            ...(agent.role !== undefined ? { role: agent.role } : {}),
        });
        const childToolRegistry = this.buildChildToolSurface(agent);

        return this.spawnFn({
            sessionId,
            prompt: request.prompt,
            agent,
            model,
            systemPrompt,
            childToolRegistry,
            childPermissions: request.childPermissions,
            workspaceRoot: this.workspaceRoot,
        });
    }

    private lookupAgent(request: ChildSpawnRequest): AgentDefinition {
        if (request.subagentType !== undefined) {
            const agent = this.agentIndex.lookup(request.subagentType);
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
            const agent = this.agentIndex.lookup(fallbackKey);
            if (agent !== undefined) return agent;
        }

        throw new ToolExecutionError({
            code: 'tool_failed',
            message: 'no agent resolved for child session (provide subagentType or a known category)',
            retryable: false,
        });
    }

    private buildChildToolSurface(child: AgentDefinition): ToolRegistry {
        const pathPolicies = deriveChildPathPolicies(this.parentAgent, child);

        const registry = this.parentToolRegistry.cloneWithFilter(
            (ad) => ad.name !== TASK_TOOL_NAME && !isToolDeniedByPathPolicies(ad.capabilityClasses, pathPolicies),
        );

        registry.register(createYieldToolRegistration({}));
        return registry;
    }
}

function isToolDeniedByPathPolicies(
    capabilities: readonly string[],
    pathPolicies: readonly PolicyEffectRule[],
): boolean {
    if (pathPolicies.length === 0) return false;
    return capabilities.some((capability) => evaluatePathPolicies(capability, '**', pathPolicies).effect === 'deny');
}
