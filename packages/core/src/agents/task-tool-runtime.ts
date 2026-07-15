import type { AgentDefinition } from '@mission-control/protocol';
import type { ChildHostCallbacks } from '../behavior/subagents/spawn-child.js';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import type {
    ChildSpawnRequest,
    ChildSpawnResult,
    TaskToolBackgroundHandle,
    TaskToolRuntime,
} from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { AgentIndex } from './agent-registry.js';
import { getRuntimeRegistry, MAIN_AGENT_ID, type RuntimeAgentRegistry } from './runtime-registry.js';
import {
    assertAgentSpawnAllowed,
    childDisplayName,
    childResumeError,
    type PreparedChildSpawnAuthority,
    prepareChildSpawnAuthority,
} from './task-tool-runtime-authority.js';
import { startBackgroundChildSession } from './task-tool-runtime-background.js';
import {
    type ChildSpawnContext,
    type ConcreteTaskToolRuntimeOptions,
    type ResolveAgentModelFn,
    resolveTaskToolSpawnFn,
    type SpawnFn,
    type TaskToolRuntimeServices,
} from './task-tool-runtime-contract.js';
import { runForegroundChildSession } from './task-tool-runtime-foreground.js';
import type { TaskToolSubagentMirror } from './task-tool-runtime-types.js';
import { randomBytes } from 'node:crypto';

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
    }

    async runChildSession(request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        this.services?.sessionControlHost?.assertChildSpawnAllowed(this.parentSessionId);
        this.assertSpawnAllowed(request);
        return this.runForegroundChildSession(request.sessionId, request, this.prepareSpawn(request));
    }

    startBackgroundSession(request: ChildSpawnRequest): TaskToolBackgroundHandle {
        if (this.services === undefined) {
            throw new Error(NO_SERVICES_MESSAGE);
        }
        this.services.sessionControlHost?.assertChildSpawnAllowed(this.parentSessionId);
        this.assertSpawnAllowed(request);
        const prepared = this.prepareSpawn(request);
        return startBackgroundChildSession({
            request,
            services: this.services,
            parentSessionId: this.parentSessionId,
            authorityFingerprint: prepared.authorityFingerprint,
            executeSpawn: (sessionId, signal, controlEpoch) =>
                this.executeSpawn({
                    sessionId,
                    request,
                    prepared,
                    signal,
                    ...(controlEpoch !== undefined ? { controlEpoch } : {}),
                }),
        });
    }

    async resumeChildSession(sessionId: string, request: ChildSpawnRequest): Promise<ChildSpawnResult> {
        this.services?.sessionControlHost?.assertChildSpawnAllowed(this.parentSessionId);
        this.assertSpawnAllowed(request);
        const child = this.runtimeRegistry().lookup(sessionId);
        if (!this.sessionExists(sessionId) || child === undefined) {
            throw childResumeError(sessionId, 'session is not resumable');
        }
        const prepared = this.prepareSpawn(request);
        if (child.authorityFingerprint !== prepared.authorityFingerprint) {
            throw childResumeError(sessionId, 'child authority does not match the original session');
        }
        return this.runForegroundChildSession(sessionId, request, prepared);
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
            ...(this.hostCallbacks !== undefined ? { hostCallbacks: this.hostCallbacks } : {}),
        });
    }

    private prepareSpawn(request: ChildSpawnRequest): PreparedChildSpawnAuthority {
        return prepareChildSpawnAuthority({
            agentIndex: this.agentIndex,
            resolveModel: this.resolveModelFn,
            parentToolRegistry: this.parentToolRegistry,
            parentAgent: this.parentAgent,
            parentSessionId: this.parentSessionId,
            workspaceRoot: this.workspaceRoot,
            request,
        });
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
