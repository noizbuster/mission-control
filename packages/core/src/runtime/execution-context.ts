import type { CancellationToken, TaskStatus } from '../cancellation.js';

export type AgentExecutionContext = {
    readonly sessionId: string;
    readonly cancellationToken?: CancellationToken;
    readonly metadata?: Record<string, unknown>;
};

export type AgentTask = {
    readonly id: string;
    readonly kind: string;
    readonly payload?: Record<string, unknown>;
};

export type AgentTaskResult = {
    readonly taskId: string;
    readonly status: TaskStatus;
    readonly output?: string;
};
