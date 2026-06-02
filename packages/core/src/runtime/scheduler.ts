import type { CancellationToken, TaskHandle, TaskStatus } from '../cancellation.js';
import type { AgentTask } from './execution-context.js';

export interface AgentScheduler {
    schedule(task: AgentTask): Promise<TaskHandle>;
    cancel(taskId: string): Promise<void>;
}

export class MockAgentScheduler implements AgentScheduler {
    private readonly handles = new Map<string, MutableTaskHandle>();

    async schedule(task: AgentTask): Promise<TaskHandle> {
        const handle = new MutableTaskHandle(task.id);
        this.handles.set(task.id, handle);
        return handle;
    }

    async cancel(taskId: string): Promise<void> {
        await this.handles.get(taskId)?.cancel('scheduler cancel placeholder');
    }
}

class MutableTaskHandle implements TaskHandle {
    private currentStatus: TaskStatus = 'running';
    private currentCancellationToken: CancellationToken = {
        isCancellationRequested: false,
    };

    constructor(readonly id: string) {}

    get status(): TaskStatus {
        return this.currentStatus;
    }

    get cancellationToken(): CancellationToken {
        return this.currentCancellationToken;
    }

    async cancel(reason?: string): Promise<void> {
        this.currentStatus = 'cancelled';
        this.currentCancellationToken = {
            isCancellationRequested: true,
            ...(reason !== undefined ? { reason } : {}),
        };
    }
}
