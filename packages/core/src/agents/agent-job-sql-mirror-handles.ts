import type { SessionBackgroundJob } from '../memory/session-status-derivation';
import type { ResolveSubagentWaitInput } from './agent-job-sql-mirror-types';
import {
    type BackgroundJobHandle,
    type DurableBackgroundJobHandle,
    durableSnapshotJobHandle,
} from './async-job-manager';

export const activeJobStatuses: ReadonlySet<BackgroundJobHandle['status']> = new Set(['queued', 'running']);

export function cancelRecoveredJob(job: BackgroundJobHandle): DurableBackgroundJobHandle {
    return durableSnapshotJobHandle({
        ...job,
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        cancellationReason: 'recovered_after_restart',
    });
}

export function resolvedSubagentJob(input: ResolveSubagentWaitInput, now: string): DurableBackgroundJobHandle {
    return {
        jobId: input.childSessionId,
        sessionId: input.childSessionId,
        parentSessionId: input.parentSessionId,
        blocking: true,
        status: input.status,
        startedAt: now,
        completedAt: now,
        ...(input.status === 'cancelled'
            ? { cancellationReason: 'cancelled' }
            : {
                  result: {
                      status: input.status,
                      output: input.output,
                      ...(input.failure !== undefined ? { failure: input.failure } : {}),
                  },
              }),
    };
}

export function backgroundJobFrom(handle: BackgroundJobHandle): SessionBackgroundJob {
    return {
        jobId: handle.jobId,
        blocking: handle.blocking === true,
        status: handle.status,
        childSessionId: handle.sessionId,
    };
}
