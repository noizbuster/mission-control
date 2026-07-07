import type { AgentDefinition, PolicyEffectRule } from '@mission-control/protocol';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child.js';
import type { SdkModelResolver } from '../providers/ai-sdk/model-resolver.js';
import { JOB_TOOL_NAME } from '../tools/job-tool.js';
import type {
    ChildSpawnRequest,
    ChildSpawnResult,
    TaskToolBackgroundHandle,
    TaskToolRuntime,
} from '../tools/task/task-tool.js';
import { TASK_TOOL_NAME } from '../tools/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutionError } from '../tools/tool-registry-types.js';
import { createYieldToolRegistration } from '../tools/yield-tool/yield-tool.js';
import type { AgentIndex } from './agent-registry.js';
import type { AsyncJobManager, JobExecuteFn } from './async-job-manager.js';
import { createChildGraphSpawnFn, defaultSpawnFn, hasHardDroppedCapability } from './child-graph-spawn.js';
import type { AgentLifecycleManager } from './lifecycle-manager.js';
import { type ModelPattern } from './model-resolver.js';
import { deriveChildPathPolicies, evaluatePathPolicies } from './path-policy-derive.js';
import { getRuntimeRegistry, MAIN_AGENT_ID, type RuntimeAgentRegistry } from './runtime-registry.js';
import { buildChildSystemPrompt } from './spawn-prompt-builder.js';
import type { TaskToolSubagentMirror } from './task-tool-runtime-types.js';
import { randomBytes } from 'node:crypto';

export interface TaskToolRuntimeServices {
    readonly jobManager: AsyncJobManager;
    readonly lifecycleManager: AgentLifecycleManager;
    readonly runtimeRegistry: RuntimeAgentRegistry;
    readonly mirror?: TaskToolSubagentMirror;
}

export type { TaskToolSubagentMirror };

export type ResolveAgentModelFn = (agent: AgentDefinition) => ModelPattern;

export interface ChildSpawnContext {
    readonly sessionId: string;
    readonly prompt: string;
    readonly agent: AgentDefinition;
    readonly model: ModelPattern;
    readonly systemPrompt: string;
    readonly childToolRegistry: ToolRegistry;
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly workspaceRoot: string;
    readonly hostCallbacks?: ChildHostCallbacks;
}

export type SpawnFn = (context: ChildSpawnContext) => Promise<ChildSpawnResult>;

export interface ConcreteTaskToolRuntimeOptions {
    readonly agentIndex: AgentIndex;
    readonly resolveModel: ResolveAgentModelFn;
    readonly workspaceRoot: string;
    readonly parentToolRegistry: ToolRegistry;
    readonly parentAgent: AgentDefinition;
    readonly spawnFn?: SpawnFn;
    readonly services?: TaskToolRuntimeServices;
    readonly parentSessionId?: string;
    readonly resolveSdkModel?: SdkModelResolver;
    readonly summaryLimit?: number;
    readonly hostCallbacks?: ChildHostCallbacks;
}

const NO_SERVICES_MESSAGE =
    'startBackgroundSession: background services not yet implemented (inject MissionControlServices to enable)';

function resolveSpawnFn(options: ConcreteTaskToolRuntimeOptions): SpawnFn {
    if (options.spawnFn !== undefined) return options.spawnFn;
    if (options.resolveSdkModel !== undefined) {
        return createChildGraphSpawnFn({
            resolveSdkModel: options.resolveSdkModel,
            ...(options.summaryLimit !== undefined ? { summaryLimit: options.summaryLimit } : {}),
        });
    }
    return defaultSpawnFn;
}

export class ConcreteTaskToolRuntime implements TaskToolRuntime {
    private readonly agentIndex: AgentIndex;
    private readonly resolveModelFn: ResolveAgentModelFn;
    private readonly workspaceRoot: string;
    private readonly parentToolRegistry: ToolRegistry;
    private readonly parentAgent: AgentDefinition;
    private readonly spawnFn: SpawnFn;
    private readonly services: TaskToolRuntimeServices | undefined;
    private readonly hostCallbacks: ChildHostCallbacks | undefined;
    private readonly parentSessionId: string;

    constructor(options: ConcreteTaskToolRuntimeOptions) {
        this.agentIndex = options.agentIndex;
        this.resolveModelFn = options.resolveModel;
        this.workspaceRoot = options.workspaceRoot;
        this.parentToolRegistry = options.parentToolRegistry;
        this.parentAgent = options.parentAgent;
        this.spawnFn = resolveSpawnFn(options);
        this.services = options.services;
        this.hostCallbacks = options.hostCallbacks;
        this.parentSessionId = options.parentSessionId ?? MAIN_AGENT_ID;
    }

    async runChildSession(request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        return this.runForegroundChildSession(request.sessionId, request);
    }

    startBackgroundSession(request: ChildSpawnRequest): TaskToolBackgroundHandle {
        if (this.services === undefined) {
            throw new Error(NO_SERVICES_MESSAGE);
        }
        return this.startBackgroundSessionWithServices(request, this.services);
    }

    async resumeChildSession(sessionId: string, request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        return this.runForegroundChildSession(sessionId, request);
    }

    sessionExists(sessionId: string): boolean {
        return getRuntimeRegistry().lookup(sessionId) !== undefined;
    }

    generateSessionId(): string {
        return `session_${Date.now()}_${randomBytes(4).toString('hex')}`;
    }

    private startBackgroundSessionWithServices(
        request: ChildSpawnRequest,
        services: TaskToolRuntimeServices,
    ): TaskToolBackgroundHandle {
        const { jobManager, runtimeRegistry } = services;
        const sessionId = request.sessionId;
        const agentId = childDisplayName(request);

        runtimeRegistry.adopt({
            id: sessionId,
            displayName: agentId,
            kind: 'sub',
            parentId: MAIN_AGENT_ID,
            status: 'running',
            sessionId,
        });

        const execute: JobExecuteFn = async () => {
            try {
                const result = await this.executeSpawn(sessionId, request);
                runtimeRegistry.update(sessionId, {
                    status: result.status === 'failed' ? 'aborted' : 'idle',
                });
                return { status: result.status, output: result.output };
            } catch (error) {
                runtimeRegistry.update(sessionId, { status: 'aborted' });
                throw error;
            }
        };

        const handle = jobManager.startJob({
            sessionId,
            parentSessionId: this.parentSessionId,
            agentId,
            blocking: false,
            execute,
        });
        return { sessionId, backgroundId: handle.jobId };
    }

    private async runForegroundChildSession(sessionId: string, request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        const agentId = childDisplayName(request);
        this.services?.runtimeRegistry.adopt({
            id: sessionId,
            displayName: agentId,
            kind: 'sub',
            parentId: MAIN_AGENT_ID,
            status: 'running',
            sessionId,
        });
        await this.services?.mirror?.startSubagentWait({
            parentSessionId: this.parentSessionId,
            childSessionId: sessionId,
            agentId,
            mode: 'sync',
        });

        try {
            const result = await this.executeSpawn(sessionId, request);
            this.services?.runtimeRegistry.update(sessionId, {
                status: result.status === 'failed' ? 'aborted' : 'idle',
            });
            await this.services?.mirror?.resolveSubagentWait({
                parentSessionId: this.parentSessionId,
                childSessionId: sessionId,
                status: result.status,
                output: result.output,
            });
            return result;
        } catch (error: unknown) {
            this.services?.runtimeRegistry.update(sessionId, { status: 'aborted' });
            await this.services?.mirror?.resolveSubagentWait({
                parentSessionId: this.parentSessionId,
                childSessionId: sessionId,
                status: 'failed',
                output: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
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
            ...(this.hostCallbacks !== undefined ? { hostCallbacks: this.hostCallbacks } : {}),
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
            (ad) =>
                ad.name !== TASK_TOOL_NAME &&
                ad.name !== JOB_TOOL_NAME &&
                !hasHardDroppedCapability(ad.capabilityClasses) &&
                !isToolDeniedByPathPolicies(ad.capabilityClasses, pathPolicies),
        );

        registry.register(createYieldToolRegistration({}));
        return registry;
    }
}

function childDisplayName(request: ChildSpawnRequest): string {
    return request.subagentType ?? request.category?.id ?? request.sessionId;
}

function isToolDeniedByPathPolicies(
    capabilities: readonly string[],
    pathPolicies: readonly PolicyEffectRule[],
): boolean {
    if (pathPolicies.length === 0) return false;
    return capabilities.some((capability) => evaluatePathPolicies(capability, '**', pathPolicies).effect === 'deny');
}
