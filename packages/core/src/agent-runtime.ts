import { defaultModelProviderSelection } from '@mission-control/config';
import type {
    AbgGraphInput,
    AbgGraphSnapshot,
    AgentEvent,
    AgentEventEnvelope,
    AgentSession,
    AgentSnapshot,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { runRuntimeDemoTask } from './agent-runtime-demo.js';
import type { AgentRuntimeOptions } from './agent-runtime-options.js';
import { runRuntimeProviderPromptTask } from './agent-runtime-provider-turn.js';
import { resolveSidecarCommand } from './agent-runtime-sidecar.js';
import { runRuntimeSkillInvocationTask, type SkillInvocationTaskInput } from './agent-runtime-skill.js';
import { type ApprovalUpdateInput, PermissionGate } from './approval-gate.js';
import { type AbgGraphRunResult, runAbgGraph } from './behavior/graph-runner.js';
import type { AbgTimelineEntry } from './behavior/timeline.js';
import { EventBus } from './event-bus.js';
import { MockSidecarClient } from './native/mock-sidecar-client.js';
import { ProcessSidecarClient, type SidecarClient } from './native/sidecar-client.js';
import { createDefaultPermissionDecision } from './permissions.js';
import { SessionEventLog } from './session-log.js';

export type { AgentRuntimeOptions } from './agent-runtime-options.js';
export type { SkillInvocationTaskInput };

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
        this.modelProviderSelection = options.modelProviderSelection ?? defaultModelProviderSelection;
        this.sidecarClient = options.useNative
            ? new ProcessSidecarClient(resolveSidecarCommand(options), options.sidecarTimeoutMs)
            : new MockSidecarClient();
        this.approvalGate = new PermissionGate({
            resolveDecision: options.permissionDecisionResolver ?? createDefaultPermissionDecision,
            emit: (event) => {
                this.emit(event);
            },
            now: () => new Date().toISOString(),
            ...(options.pendingApprovalBehavior !== undefined
                ? { pendingApprovalBehavior: options.pendingApprovalBehavior }
                : {}),
        });
    }

    async start(): Promise<AgentSession> {
        const startedAt = new Date().toISOString();
        const session: AgentSession = {
            id: `session_${Date.now()}`,
            status: 'running',
            startedAt,
        };
        this.session = session;
        this.emit({
            type: 'session.started',
            timestamp: startedAt,
            sessionId: session.id,
            message: 'mission-control session started',
            nativeSidecarStatus: this.sidecarClient.status(),
            modelProviderSelection: this.modelProviderSelection,
        });
        return session;
    }

    async stop(): Promise<void> {
        const timestamp = new Date().toISOString();
        const sessionId = this.session?.id;
        this.session = this.session
            ? {
                  ...this.session,
                  status: 'stopped',
                  stoppedAt: timestamp,
              }
            : undefined;
        this.emit({
            type: 'session.stopped',
            timestamp,
            ...(sessionId ? { sessionId } : {}),
            message: 'mission-control session stopped',
            nativeSidecarStatus: this.sidecarClient.status(),
            modelProviderSelection: this.modelProviderSelection,
        });
    }

    async runDemoTask(): Promise<void> {
        const session = this.ensureSession();
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

    async runPromptTask(prompt: string): Promise<string> {
        const session = this.ensureSession();
        const taskId = this.createPromptTaskId();
        await this.requestPermission(
            {
                id: `permission_${taskId}`,
                action: 'prompt.submit',
                reason: 'user chat prompt permission gate',
            },
            taskId,
        );
        this.emit({
            type: 'task.started',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            message: `user prompt: ${prompt}`,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
        });
        const response = await this.runProviderPromptTask(taskId, prompt);
        this.emit({
            type: 'task.completed',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            message: response,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
        });
        return response;
    }

    async runSkillInvocationTask(input: SkillInvocationTaskInput): Promise<string> {
        const session = this.ensureSession();
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

    async runGraph(graph: unknown, graphInput?: AbgGraphInput): Promise<AbgGraphRunResult> {
        const session = this.ensureSession();
        const result = await runAbgGraph({
            graph,
            sessionId: session.id,
            now: () => new Date().toISOString(),
            modelProviderSelection: this.modelProviderSelection,
            ...(graphInput !== undefined ? { graphInput } : {}),
        });
        for (const event of result.events) {
            this.emit(event);
        }
        return result;
    }

    async requestPermission(request: PermissionRequest, taskId?: string): Promise<PermissionDecision> {
        const session = this.ensureSession();
        return this.approvalGate.requestPermission(request, {
            sessionId: session.id,
            ...(taskId !== undefined ? { taskId } : {}),
            modelProviderSelection: this.modelProviderSelection,
        });
    }

    updateApproval(input: ApprovalUpdateInput): void {
        this.ensureSession();
        this.approvalGate.updateApproval(input);
    }

    onEvent(listener: (event: AgentEvent) => void): () => void {
        return this.bus.subscribe(listener);
    }

    getEvents(): readonly AgentEvent[] {
        return this.log.getEvents();
    }

    getSnapshot(): AgentSnapshot {
        const session = this.ensureSession();
        return this.log.getSnapshot(session);
    }

    getGraphSnapshot(graphId: string): AbgGraphSnapshot {
        this.ensureSession();
        return this.log.getGraphSnapshot(graphId);
    }

    getTimeline(): readonly AbgTimelineEntry[] {
        this.ensureSession();
        return this.log.getTimeline();
    }

    private emit(event: AgentEvent): void {
        this.log.append(event);
        this.bus.emit(event);
    }

    private emitProviderEnvelope(envelope: AgentEventEnvelope): void {
        if (envelope.durability === 'durable') {
            this.emit(envelope.event);
            return;
        }
        this.bus.emit(envelope.event);
    }

    private ensureSession(): AgentSession {
        if (this.session) {
            return this.session;
        }
        throw new Error('AgentRuntime has not been started');
    }

    private createPromptTaskId(): string {
        this.promptTaskCounter += 1;
        return `task_prompt_${this.promptTaskCounter}`;
    }

    private async runProviderPromptTask(taskId: string, prompt: string): Promise<string> {
        const session = this.ensureSession();
        if (this.options.provider === undefined) {
            return `received prompt: ${prompt}`;
        }
        return runRuntimeProviderPromptTask({
            provider: this.options.provider,
            sessionId: session.id,
            taskId,
            prompt,
            modelProviderSelection: this.modelProviderSelection,
            ...(this.options.providerTimeoutMs !== undefined
                ? { providerTimeoutMs: this.options.providerTimeoutMs }
                : {}),
            ...(this.options.providerRetryLimit !== undefined
                ? { providerRetryLimit: this.options.providerRetryLimit }
                : {}),
            ...(this.options.providerTurnLoopLimit !== undefined
                ? { providerTurnLoopLimit: this.options.providerTurnLoopLimit }
                : {}),
            requestPermission: (request) => this.requestPermission(request, taskId),
            onEnvelope: (envelope) => {
                this.emitProviderEnvelope(envelope);
            },
        });
    }
}
