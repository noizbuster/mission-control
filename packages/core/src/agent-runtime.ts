import type {
    AbgGraphInput,
    AbgGraphSnapshot,
    AbgNodeModelOptions,
    AgentEvent,
    AgentSession,
    AgentSnapshot,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ProjectInstructionResource } from './context/project-context-messages.js';
import type { SystemPromptEnvironment } from './context/system-prompt.js';
import { runRuntimeDemoTask } from './agent-runtime-demo.js';
import type { AgentRuntimeOptions } from './agent-runtime-options.js';
import { runRuntimeSkillInvocationTask, type SkillInvocationTaskInput } from './agent-runtime-skill.js';
import {
    allocatePromptTaskId,
    createRuntimeApprovalGate,
    createRuntimeSession,
    createRuntimeSidecarClient,
    emitRuntimeEnvelope,
    ensureRuntimeSession,
    runtimeModelProviderSelection,
    sessionStartedEvent,
    sessionStoppedEvent,
    stopRuntimeSession,
    taskCompletedEvent,
    taskStartedEvent,
} from './agent-runtime-support.js';
import { type ApprovalUpdateInput, PermissionGate } from './approval-gate.js';
import { type AbgGraphRunResult, runAbgGraph } from './behavior/graph-runner.js';
import type { AbgNodeRegistry } from './behavior/node-registry.js';
import type { LlmActorModel } from './behavior/nodes/llm-actor/llm-actor-node.js';
import type { AbgTimelineEntry } from './behavior/timeline.js';
import { EventBus } from './event-bus.js';
import type { SidecarClient } from './native/sidecar-client.js';
import { SessionEventLog } from './session-log.js';
import type { ToolRegistry } from './tools/tool-registry.js';

export type { AgentRuntimeOptions } from './agent-runtime-options.js';
export type { SkillInvocationTaskInput };

/**
 * Extra inputs for `AgentRuntime.runGraph` that wire the real Phase 1/2 coding-agent path:
 * the real node `registry`, an SDK-model resolver, the tool surface, and the seed
 * conversation. When omitted, `runGraph` uses the default (mock) registry and no tools —
 * the legacy behavior. The CLI supplies these once providers speak the AI-SDK model API
 * (Phase 5); until then the flat loop remains the default execution authority (strangler
 * fig, ABG pre-mortem #1).
 */
export type RunGraphOptions = {
    readonly registry?: AbgNodeRegistry;
    readonly resolveSdkModel?: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly toolRegistry?: ToolRegistry;
    readonly initialMessages?: readonly ModelMessage[];
    readonly abortSignal?: AbortSignal;
    readonly haltOnFailedToolSettlement?: boolean;
    /**
     * Forwarded to `AbgGraphRunnerInput.systemPromptEnv` so the LLMActor includes an environment
     * block in the system prompt. Built by the caller from process state.
     */
    readonly systemPromptEnv?: SystemPromptEnvironment;
    /**
     * Forwarded to `AbgGraphRunnerInput.projectInstructionResources` so the LLMActor appends trusted
     * AGENTS.md/CLAUDE.md instructions to the system prompt.
     */
    readonly projectInstructionResources?: readonly ProjectInstructionResource[];
};

export class AgentRuntime {
    readonly options: AgentRuntimeOptions;
    private readonly log = new SessionEventLog();
    private readonly bus = new EventBus<AgentEvent>();
    private readonly sidecarClient: SidecarClient;
    private readonly approvalGate: PermissionGate;
    private modelProviderSelection: ModelProviderSelection;
    private session: AgentSession | undefined;
    private promptTaskCounter = 0;

    constructor(options: AgentRuntimeOptions = {}) {
        this.options = options;
        this.modelProviderSelection = runtimeModelProviderSelection(options);
        this.sidecarClient = createRuntimeSidecarClient(options);
        this.approvalGate = createRuntimeApprovalGate(options, (event) => {
            this.emit(event);
        });
    }

    async start(): Promise<AgentSession> {
        const startedAt = new Date().toISOString();
        const session = createRuntimeSession(startedAt);
        this.session = session;
        this.emit(sessionStartedEvent(session, startedAt, this.sidecarClient.status(), this.modelProviderSelection));
        return session;
    }

    async stop(): Promise<void> {
        const timestamp = new Date().toISOString();
        const sessionId = this.session?.id;
        this.session = stopRuntimeSession(this.session, timestamp);
        this.emit(
            sessionStoppedEvent({
                timestamp,
                ...(sessionId !== undefined ? { sessionId } : {}),
                nativeSidecarStatus: this.sidecarClient.status(),
                modelProviderSelection: this.modelProviderSelection,
            }),
        );
        await this.sidecarClient.stop();
    }

    async runDemoTask(): Promise<void> {
        const session = ensureRuntimeSession(this.session);
        await runRuntimeDemoTask({
            sessionId: session.id,
            sidecarClient: this.sidecarClient,
            modelProviderSelection: this.modelProviderSelection,
            requestPermission: (request, taskId) => this.requestPermission(request, taskId),
            emit: (event) => {
                this.emit(event);
            },
        });
    }

    async runSkillInvocationTask(input: SkillInvocationTaskInput): Promise<string> {
        const session = ensureRuntimeSession(this.session);
        const taskId = this.createPromptTaskId();
        return runRuntimeSkillInvocationTask({
            task: input,
            sessionId: session.id,
            taskId,
            modelProviderSelection: this.modelProviderSelection,
            requestPermission: (request, requestedTaskId) => this.requestPermission(request, requestedTaskId),
            emit: (event) => {
                this.emit(event);
            },
        });
    }

    setModelProviderSelection(modelProviderSelection: ModelProviderSelection): void {
        this.modelProviderSelection = modelProviderSelection;
    }

    async runGraph(graph: unknown, graphInput?: AbgGraphInput, options?: RunGraphOptions): Promise<AbgGraphRunResult> {
        const session = ensureRuntimeSession(this.session);
        const result = await runAbgGraph({
            graph,
            sessionId: session.id,
            now: () => new Date().toISOString(),
            modelProviderSelection: this.modelProviderSelection,
            ...(graphInput !== undefined ? { graphInput } : {}),
            ...(options?.registry !== undefined ? { registry: options.registry } : {}),
            ...(options?.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
            ...(options?.toolRegistry !== undefined ? { toolRegistry: options.toolRegistry } : {}),
        ...(options?.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        ...(options?.haltOnFailedToolSettlement === true ? { haltOnFailedToolSettlement: true } : {}),
        ...(options?.systemPromptEnv !== undefined ? { systemPromptEnv: options.systemPromptEnv } : {}),
        ...(options?.projectInstructionResources !== undefined
            ? { projectInstructionResources: options.projectInstructionResources }
            : {}),
    });
        for (const event of result.events) {
            this.emit(event);
        }
        return result;
    }

    async requestPermission(request: PermissionRequest, taskId?: string): Promise<PermissionDecision> {
        const session = ensureRuntimeSession(this.session);
        return this.approvalGate.requestPermission(request, {
            sessionId: session.id,
            ...(taskId !== undefined ? { taskId } : {}),
            modelProviderSelection: this.modelProviderSelection,
        });
    }

    updateApproval(input: ApprovalUpdateInput): void {
        ensureRuntimeSession(this.session);
        this.approvalGate.updateApproval(input);
    }

    onEvent(listener: (event: AgentEvent) => void): () => void {
        return this.bus.subscribe(listener);
    }

    getEvents(): readonly AgentEvent[] {
        return this.log.getEvents();
    }

    getSnapshot(): AgentSnapshot {
        const session = ensureRuntimeSession(this.session);
        return this.log.getSnapshot(session);
    }

    getGraphSnapshot(graphId: string): AbgGraphSnapshot {
        ensureRuntimeSession(this.session);
        return this.log.getGraphSnapshot(graphId);
    }

    getTimeline(): readonly AbgTimelineEntry[] {
        ensureRuntimeSession(this.session);
        return this.log.getTimeline();
    }

    private emit(event: AgentEvent): void {
        this.log.append(event);
        this.bus.emit(event);
    }

    private createPromptTaskId(): string {
        const allocation = allocatePromptTaskId(this.promptTaskCounter);
        this.promptTaskCounter = allocation.nextPromptTaskCounter;
        return allocation.taskId;
    }
}
