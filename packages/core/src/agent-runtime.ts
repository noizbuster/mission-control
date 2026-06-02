import type {
    AgentEvent,
    AgentSession,
    AgentSnapshot,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import { EventBus } from './event-bus.js';
import { MockSidecarClient } from './native/mock-sidecar-client.js';
import { ProcessSidecarClient, type SidecarClient } from './native/sidecar-client.js';
import { createDefaultPermissionDecision } from './permissions.js';
import { SessionEventLog } from './session-log.js';

export type AgentRuntimeOptions = {
    readonly useNative?: boolean;
    readonly sidecarCommand?: string;
    readonly sidecarTimeoutMs?: number;
};

export class AgentRuntime {
    readonly options: AgentRuntimeOptions;
    private readonly log = new SessionEventLog();
    private readonly bus = new EventBus<AgentEvent>();
    private readonly sidecarClient: SidecarClient;
    private session: AgentSession | undefined;

    constructor(options: AgentRuntimeOptions = {}) {
        this.options = options;
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
        });
        this.emit({
            type: 'task.progress',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            progress: 0.5,
            message: 'demo task in progress',
            nativeSidecarStatus: 'mock',
        });
        const output = await this.runTaskWithFallback(taskId);
        this.emit({
            type: 'task.completed',
            timestamp: new Date().toISOString(),
            sessionId: session.id,
            taskId,
            message: output.message,
            nativeSidecarStatus: 'mock',
        });
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
    return options.sidecarCommand ?? process.env['MISSION_CONTROL_SIDECAR'] ?? 'mission-control-sidecar';
}
