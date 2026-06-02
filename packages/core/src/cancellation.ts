export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly reason?: string;
}

export interface TaskHandle {
    readonly id: string;
    readonly status: TaskStatus;
    readonly cancellationToken: CancellationToken;
    cancel(reason?: string): Promise<void>;
}

export const neverCancelledToken: CancellationToken = {
    isCancellationRequested: false,
};
