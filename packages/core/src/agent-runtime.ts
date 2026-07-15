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
import { runRuntimeDemoTask } from './agent-runtime-demo';
import type { AgentRuntimeOptions } from './agent-runtime-options';
import { runRuntimeSkillInvocationTask, type SkillInvocationTaskInput } from './agent-runtime-skill';
import {
    allocatePromptTaskId,
    createRuntimeApprovalGate,
    createRuntimeSession,
    createRuntimeSidecarClient,
    ensureRuntimeSession,
    runtimeModelProviderSelection,
    sessionStartedEvent,
    sessionStoppedEvent,
    stopRuntimeSession,
} from './agent-runtime-support';
import { type ApprovalUpdateInput, PermissionGate } from './approval-gate';
import type { PricingTable } from './behavior/budget/cost-ledger';
import { type AbgGraphRunResult, runAbgGraph } from './behavior/graph-runner';
import type { AbgNodeRegistry } from './behavior/node-registry';
import type { LlmActorModel } from './behavior/nodes/llm-actor/llm-actor-node';
import type { AbgTimelineEntry } from './behavior/timeline';
import type { ProjectInstructionResource } from './context/project-context-messages';
import type { SystemPromptEnvironment } from './context/system-prompt';
import { EventBus } from './event-bus';
import type { PersistentMemoryStore } from './memory/persistent-memory-store';
import type { SidecarClient } from './native/sidecar-client';
import {
    composeObservabilityRedactors,
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventForObservability,
} from './providers/observability-redactor';
import { SessionEventLog } from './session-log';
import type { ToolRegistry } from './tools/tool-registry';

export type { AgentRuntimeOptions } from './agent-runtime-options';
export type { SkillInvocationTaskInput };

/**
 * Extra inputs for `AgentRuntime.runGraph` that wire the coding-agent path: the real node
 * `registry`, an SDK-model resolver, the tool surface, and the seed conversation. Current CLI
 * prompt execution supplies these inputs and runs through the graph engine. Omitting them retains
 * the low-level mock/no-tool fallback; the flat provider loop is only a limited fallback path.
 */
export type RunGraphOptions = {
    readonly registry?: AbgNodeRegistry;
    readonly resolveSdkModel?: (options: AbgNodeModelOptions) => LlmActorModel;
    readonly agentModelLookup?: import('./behavior/agent-model-resolver').AgentModelLookup;
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
    /**
     * Forwarded to `AbgGraphRunnerInput.pricingTable` so the CostLedger prices each LLMActor turn
     * and emits `policy.budget.accumulated`/`.warning`/`.exceeded` events. Operator-supplied;
     * absent by default (the ledger stays `undefined` and no budget events fire).
     */
    readonly pricingTable?: PricingTable;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export class AgentRuntime {
    readonly options: AgentRuntimeOptions;
    private readonly log = new SessionEventLog();
    private readonly bus = new EventBus<AgentEvent>();
    private readonly sidecarClient: SidecarClient;
    private readonly approvalGate: PermissionGate;
    private readonly persistentStore: PersistentMemoryStore | undefined;
    private readonly observabilityRedactor: ObservabilityRedactor;
    private modelProviderSelection: ModelProviderSelection;
    private session: AgentSession | undefined;
    private frozenSnapshot: AgentSnapshot | undefined = undefined;
    private promptTaskCounter = 0;

    constructor(options: AgentRuntimeOptions = {}) {
        this.options = options;
        this.modelProviderSelection = runtimeModelProviderSelection(options);
        this.sidecarClient = createRuntimeSidecarClient(options);
        this.observabilityRedactor = options.observabilityRedactor ?? createObservabilityRedactor();
        this.approvalGate = createRuntimeApprovalGate(options, (event) => {
            this.emit(event);
        });
        this.persistentStore = options.persistentStore;
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
        this.frozenSnapshot = this.log.getSnapshot(ensureRuntimeSession(this.session));
        this.log.clear();
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
        const observabilityRedactor = composeObservabilityRedactors(
            options?.observabilityRedactor === undefined
                ? [this.observabilityRedactor]
                : [this.observabilityRedactor, options.observabilityRedactor],
        );
        const result = await runAbgGraph({
            graph,
            sessionId: session.id,
            now: () => new Date().toISOString(),
            modelProviderSelection: this.modelProviderSelection,
            ...(graphInput !== undefined ? { graphInput } : {}),
            ...(options?.registry !== undefined ? { registry: options.registry } : {}),
            ...(options?.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
            ...(options?.agentModelLookup !== undefined ? { agentModelLookup: options.agentModelLookup } : {}),
            ...(options?.toolRegistry !== undefined ? { toolRegistry: options.toolRegistry } : {}),
            ...(options?.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
            ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
            ...(options?.haltOnFailedToolSettlement === true ? { haltOnFailedToolSettlement: true } : {}),
            ...(options?.systemPromptEnv !== undefined ? { systemPromptEnv: options.systemPromptEnv } : {}),
            ...(options?.projectInstructionResources !== undefined
                ? { projectInstructionResources: options.projectInstructionResources }
                : {}),
            ...(options?.pricingTable !== undefined ? { pricingTable: options.pricingTable } : {}),
            observabilityRedactor,
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
        if (this.frozenSnapshot !== undefined) {
            return this.frozenSnapshot;
        }
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

    getPersistentStore(): PersistentMemoryStore | undefined {
        return this.persistentStore;
    }

    private emit(event: AgentEvent): void {
        const observableEvent = redactAgentEventForObservability(event, this.observabilityRedactor);
        this.log.append(observableEvent);
        this.bus.emit(observableEvent);
    }

    private createPromptTaskId(): string {
        const allocation = allocatePromptTaskId(this.promptTaskCounter);
        this.promptTaskCounter = allocation.nextPromptTaskCounter;
        return allocation.taskId;
    }
}
