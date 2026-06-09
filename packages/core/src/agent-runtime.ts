import { defaultModelProviderSelection } from '@mission-control/config';
import type {
    AbgGraphInput,
    AbgGraphSnapshot,
    AgentEvent,
    AgentSession,
    AgentSnapshot,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { type AbgGraphRunResult, runAbgGraph } from './behavior/graph-runner.js';
import type { AbgTimelineEntry } from './behavior/timeline.js';
import { EventBus } from './event-bus.js';
import { MockSidecarClient } from './native/mock-sidecar-client.js';
import { ProcessSidecarClient, type SidecarClient } from './native/sidecar-client.js';
import { createDefaultPermissionDecision } from './permissions.js';
import { SessionEventLog } from './session-log.js';

const sidecarEnvKey = 'MISSION_CONTROL_SIDECAR';

export type AgentRuntimeOptions = {
    readonly useNative?: boolean;
    readonly sidecarCommand?: string;
    readonly sidecarTimeoutMs?: number;
    readonly modelProviderSelection?: ModelProviderSelection;
};

export type SkillInvocationTaskInput = {
    readonly skillID: string;
    readonly argumentsText: string;
};

export class AgentRuntime {
    readonly options: AgentRuntimeOptions;
    private readonly log = new SessionEventLog();
    private readonly bus = new EventBus<AgentEvent>();
    private readonly sidecarClient: SidecarClient;
    private modelProviderSelection: ModelProviderSelection;
    private session: AgentSession | undefined;
    private promptTaskCounter = 0;

    constructor(options: AgentRuntimeOptions = {}) {
        this.options = options;
        this.modelProviderSelection = options.modelProviderSelection ?? defaultModelProviderSelection;
        this.sidecarClient = options.useNative
            ? new ProcessSidecarClient(resolveSidecarCommand(options), options.sidecarTimeoutMs)
            : new MockSidecarClient();
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
            nativeSidecarStatus: 'mock',
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
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
        });
    }

    async runDemoTask(): Promise<void> {
        const session = this.ensureSession();
        const taskId = 'task_demo';
        await this.requestPermission(
            {
                id: `permission_${taskId}`,
                action: 'task.run',
                reason: 'demo task permission gate',
            },
            taskId,
        );
        this.emit({
            type: 'task.started',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            message: 'demo task started',
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
        });
        this.emit({
            type: 'task.progress',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            progress: 0.5,
            message: 'demo task in progress',
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
        });
        const output = await this.runTaskWithFallback(taskId);
        this.emit({
            type: 'task.completed',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            message: output.message,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
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
        const response = `received prompt: ${prompt}`;
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
        await this.requestPermission(
            {
                id: `permission_${taskId}`,
                action: 'skill.invoke',
                reason: `skill invocation permission gate: ${input.skillID}`,
            },
            taskId,
        );
        this.emit({
            type: 'task.started',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            message: `skill invocation started: ${input.skillID}`,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
        });
        const response = `skill invocation scaffolded: ${input.skillID}`;
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
        const decision: PermissionDecision = createDefaultPermissionDecision(request);
        this.emit({
            type: 'permission.requested',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            ...(taskId !== undefined ? { taskId } : {}),
            message: `permission requested: ${request.action}`,
            nativeSidecarStatus: 'mock',
            modelProviderSelection: this.modelProviderSelection,
            permissionRequest: request,
            permissionDecision: decision,
        });
        return decision;
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

    private async runTaskWithFallback(taskId: string) {
        try {
            return await this.sidecarClient.runTask({
                id: taskId,
                payload: {
                    label: 'demo',
                },
            });
        } catch (error: unknown) {
            this.emit({
                type: 'native.warning',
                timestamp: new Date().toISOString(),
                sessionId: this.session?.id,
                taskId,
                message: error instanceof Error ? error.message : String(error),
                nativeSidecarStatus: 'unavailable',
                modelProviderSelection: this.modelProviderSelection,
            });
            const mock = new MockSidecarClient();
            return mock.runTask({
                id: taskId,
                payload: {
                    label: 'demo',
                },
            });
        }
    }
}

function resolveSidecarCommand(options: AgentRuntimeOptions): string {
    return options.sidecarCommand ?? process.env[sidecarEnvKey] ?? 'mission-control-sidecar';
}
