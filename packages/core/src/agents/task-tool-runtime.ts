// allow: SIZE_OK - HEAD 272 -> current ~281 pure LOC; compose child activity timestamp observer into the spawn host callbacks
import type { AgentDefinition } from '@mission-control/protocol';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import type {
    ChildSpawnRequest,
    ChildSpawnResult,
    TaskToolBackgroundHandle,
    TaskToolRuntime,
} from '../tools/task/task-tool';
import { createFullParityTaskToolRegistration } from '../tools/task/task-tool';
import { withNestSubagentPermission } from '../tools/task/task-tool-routing';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutionError } from '../tools/tool-registry-types';
import { composeChildHostCallbacksWithActivity } from './child-activity-touch';
import { canSpawnAtDepth, PRODUCTION_MAX_TASK_DEPTH } from './recursion-policy';
import type { AgentIndex } from './agent-registry';
import { getRuntimeRegistry, MAIN_AGENT_ID, type RuntimeAgentRegistry } from './runtime-registry';
import {
    assertAgentSpawnAllowed,
    childDisplayName,
    childResumeError,
    type PreparedChildSpawnAuthority,
    prepareChildSpawnAuthority,
} from './task-tool-runtime-authority';
import { startBackgroundChildSession } from './task-tool-runtime-background';
import {
    type ChildSpawnContext,
    type ConcreteTaskToolRuntimeOptions,
    type ResolveAgentModelFn,
    resolveTaskToolSpawnFn,
    type SpawnFn,
    type TaskToolRuntimeServices,
} from './task-tool-runtime-contract';
import { runForegroundChildSession } from './task-tool-runtime-foreground';
import type { TaskToolSubagentMirror } from './task-tool-runtime-types';
import { randomBytes } from 'node:crypto';

export { PRODUCTION_MAX_TASK_DEPTH } from './recursion-policy';
export type {
    ChildSpawnContext,
    ConcreteTaskToolRuntimeOptions,
    ResolveAgentModelFn,
    SpawnFn,
    TaskToolRuntimeServices,
    TaskToolSubagentMirror,
};

type ExecuteSpawnInput = {
    readonly sessionId: string;
    readonly request: ChildSpawnRequest;
    readonly prepared: PreparedChildSpawnAuthority;
    readonly signal: AbortSignal;
    readonly controlEpoch?: SessionControlEpoch;
};

const NO_SERVICES_MESSAGE =
    'startBackgroundSession: background services not yet implemented (inject MissionControlServices to enable)';

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
    private readonly isCliRootParent: true | undefined;

    constructor(options: ConcreteTaskToolRuntimeOptions) {
        this.agentIndex = options.agentIndex;
        this.resolveModelFn = options.resolveModel;
        this.workspaceRoot = options.workspaceRoot;
        this.parentToolRegistry = options.parentToolRegistry;
        this.parentAgent = options.parentAgent;
        this.spawnFn = resolveTaskToolSpawnFn(options);
        this.services = options.services;
        this.hostCallbacks = options.hostCallbacks;
        this.parentSessionId = options.parentSessionId ?? MAIN_AGENT_ID;
        this.isCliRootParent = options.isCliRootParent;
    }

    async runChildSession(request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        this.services?.sessionControlHost?.assertChildSpawnAllowed(this.parentSessionId);
        const prepared = this.prepareSpawn(request);
        this.assertSpawnAllowed(prepared.request);
        return this.runForegroundChildSession(prepared.request.sessionId, prepared.request, prepared);
    }

    startBackgroundSession(request: ChildSpawnRequest): TaskToolBackgroundHandle {
        if (this.services === undefined) {
            throw new Error(NO_SERVICES_MESSAGE);
        }
        this.services.sessionControlHost?.assertChildSpawnAllowed(this.parentSessionId);
        const prepared = this.prepareSpawn(request);
        this.assertSpawnAllowed(prepared.request);
        return startBackgroundChildSession({
            request: prepared.request,
            services: this.services,
            parentSessionId: this.parentSessionId,
            authorityFingerprint: prepared.authorityFingerprint,
            executeSpawn: (sessionId, signal, controlEpoch) =>
                this.executeSpawn({
                    sessionId,
                    request: prepared.request,
                    prepared,
                    signal,
                    ...(controlEpoch !== undefined ? { controlEpoch } : {}),
                }),
        });
    }

    async resumeChildSession(sessionId: string, request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        this.services?.sessionControlHost?.assertChildSpawnAllowed(this.parentSessionId);
        const prepared = this.prepareSpawn(request);
        this.assertSpawnAllowed(prepared.request);
        const child = this.runtimeRegistry().lookup(sessionId);
        if (!this.sessionExists(sessionId) || child === undefined) {
            throw childResumeError(sessionId, 'session is not resumable');
        }
        if (child.authorityFingerprint !== prepared.authorityFingerprint) {
            throw childResumeError(sessionId, 'child authority does not match the original session');
        }
        return this.runForegroundChildSession(sessionId, prepared.request, prepared);
    }

    sessionExists(sessionId: string): boolean {
        const child = this.runtimeRegistry().lookup(sessionId);
        return (
            child?.kind === 'sub' &&
            child.parentId === this.parentSessionId &&
            child.authorityFingerprint !== undefined &&
            (child.status === 'idle' || child.status === 'parked')
        );
    }

    generateSessionId(): string {
        return `session_${Date.now()}_${randomBytes(4).toString('hex')}`;
    }

    private async runForegroundChildSession(
        sessionId: string,
        request: ChildSpawnRequest,
        prepared: PreparedChildSpawnAuthority,
    ): Promise<ChildSpawnResult> {
        return runForegroundChildSession({
            child: {
                sessionId,
                agentId: childDisplayName(request),
                authorityFingerprint: prepared.authorityFingerprint,
                taskDepth: request.taskDepth ?? 0,
            },
            parentSessionId: this.parentSessionId,
            request,
            services: this.services,
            runtimeRegistry: this.runtimeRegistry(),
            spawn: (signal) =>
                this.executeSpawn({
                    sessionId,
                    request,
                    prepared,
                    signal,
                    ...(request.controlEpoch !== undefined ? { controlEpoch: request.controlEpoch } : {}),
                }),
        });
    }

    private async executeSpawn(input: ExecuteSpawnInput): Promise<ChildSpawnResult> {
        const { sessionId, request, prepared, signal, controlEpoch } = input;
        const baseHostCallbacks = this.hostCallbacksForChild(sessionId, request, prepared.agent.name);
        const hostCallbacks =
            this.services?.runtimeRegistry !== undefined
                ? composeChildHostCallbacksWithActivity(
                      baseHostCallbacks,
                      sessionId,
                      this.services.runtimeRegistry,
                    )
                : baseHostCallbacks;
        return this.spawnFn({
            sessionId,
            prompt: request.prompt,
            agent: prepared.agent,
            model: prepared.model,
            systemPrompt: prepared.systemPrompt,
            childToolRegistry: prepared.childToolRegistry,
            childPermissions: request.childPermissions,
            workspaceRoot: this.workspaceRoot,
            signal,
            ...(controlEpoch !== undefined ? { controlEpoch } : {}),
            ...(hostCallbacks !== undefined ? { hostCallbacks } : {}),
        });
    }

    private hostCallbacksForChild(
        sessionId: string,
        request: ChildSpawnRequest,
        agentName: string,
    ): ChildHostCallbacks | undefined {
        const base = this.hostCallbacks;
        if (base === undefined) {
            return undefined;
        }
        const displayName = childDisplayName(request);
        return {
            ...base,
            resolveChildAskUserSource: (sid: string) => {
                if (sid === sessionId) {
                    return {
                        agentName: displayName !== sessionId ? displayName : agentName,
                        ...(request.category !== undefined ? { category: request.category.id } : {}),
                        ...(request.title !== undefined ? { title: request.title } : {}),
                    };
                }
                return base.resolveChildAskUserSource?.(sid);
            },
        };
    }

    private prepareSpawn(request: ChildSpawnRequest): PreparedChildSpawnAuthority {
        const parentDepth = this.resolveParentDepth();
        const childDepth = parentDepth + 1;
        const nestingAllowed = canSpawnAtDepth(PRODUCTION_MAX_TASK_DEPTH, childDepth);
        const stampedRequest: ChildSpawnRequest = {
            ...request,
            taskDepth: childDepth,
            childPermissions: withNestSubagentPermission(request.childPermissions, nestingAllowed),
        };
        return prepareChildSpawnAuthority({
            agentIndex: this.agentIndex,
            resolveModel: this.resolveModelFn,
            parentToolRegistry: this.parentToolRegistry,
            parentAgent: this.parentAgent,
            parentSessionId: this.parentSessionId,
            workspaceRoot: this.workspaceRoot,
            request: stampedRequest,
            allowTaskNesting: nestingAllowed,
            ...(nestingAllowed
                ? {
                      finalizeChildRegistry: (registry, agent) => {
                          this.registerNestedTaskTool(registry, agent, stampedRequest.sessionId);
                      },
                  }
                : {}),
        });
    }

    private registerNestedTaskTool(
        childToolRegistry: ToolRegistry,
        childAgent: AgentDefinition,
        childSessionId: string,
    ): void {
        const nestedRuntime = new ConcreteTaskToolRuntime({
            agentIndex: this.agentIndex,
            resolveModel: this.resolveModelFn,
            workspaceRoot: this.workspaceRoot,
            parentToolRegistry: childToolRegistry,
            parentAgent: childAgent,
            parentSessionId: childSessionId,
            spawnFn: this.spawnFn,
            ...(this.services !== undefined ? { services: this.services } : {}),
            ...(this.hostCallbacks !== undefined ? { hostCallbacks: this.hostCallbacks } : {}),
        });
        childToolRegistry.register(createFullParityTaskToolRegistration({ runtime: nestedRuntime }));
    }

    private resolveParentDepth(): number {
        if (this.parentSessionId === MAIN_AGENT_ID || this.isCliRootParent) return 0;
        const taskDepth = this.runtimeRegistry().lookup(this.parentSessionId)?.taskDepth;
        if (taskDepth === undefined) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `cannot spawn child: parent ${this.parentSessionId} has no verified task depth`,
                retryable: false,
            });
        }
        if (taskDepth >= PRODUCTION_MAX_TASK_DEPTH) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `cannot spawn child: parent ${this.parentSessionId} reached the maximum task depth`,
                retryable: false,
            });
        }
        return taskDepth;
    }

    private assertSpawnAllowed(request: ChildSpawnRequest): void {
        assertAgentSpawnAllowed({
            agentIndex: this.agentIndex,
            parentAgent: this.parentAgent,
            parentSessionId: this.parentSessionId,
            request,
        });
    }

    private runtimeRegistry(): RuntimeAgentRegistry {
        return this.services?.runtimeRegistry ?? getRuntimeRegistry();
    }
}
