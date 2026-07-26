import {
    blockRun,
    cancelRun,
    completeRun,
    createMission,
    ensureMcDirs,
    failRun,
    materializeMission,
    type NormalizedMissionRunStoreLocation,
    normalizeMissionRunStoreLocation,
    type ObservabilityRedactor,
    type RunSessionOwnerAttachment,
    resolveMcRoot,
    type SessionControlHost,
    settleMissionRunSessionOwner,
    startRun,
} from '@mission-control/core';
import type { AbgGraphSpec, AbgGraphStatus, WorkflowSpec } from '@mission-control/protocol';
import { assertUnreachable } from '../assert-unreachable';

export type NoninteractiveWorkflowRunHandle = {
    readonly location: NormalizedMissionRunStoreLocation;
    readonly runId: string;
};

export type WorkflowRunOutcome =
    | { readonly status: 'completed' }
    | { readonly status: 'failed'; readonly reason?: string }
    | { readonly status: 'blocked'; readonly reason?: string }
    | { readonly status: 'cancelled'; readonly reason: string };

export async function beginNoninteractiveWorkflowRun(
    workspaceRoot: string,
    workflowSpec: WorkflowSpec | undefined,
    options: {
        readonly sessionId?: string;
        readonly graph?: AbgGraphSpec;
        readonly prompt?: string;
        readonly observabilityRedactor?: ObservabilityRedactor;
        readonly sessionControlHost?: SessionControlHost;
    } = {},
): Promise<NoninteractiveWorkflowRunHandle | undefined> {
    if (workflowSpec === undefined) return undefined;
    let mcRoot: string;
    try {
        mcRoot = await resolveMcRoot(workspaceRoot);
    } catch {
        return undefined;
    }
    await ensureMcDirs(mcRoot);
    const location = normalizeMissionRunStoreLocation({
        mcRoot,
        ...(options.observabilityRedactor !== undefined
            ? { observabilityRedactor: options.observabilityRedactor }
            : {}),
    });
    const mission = materializeMission({ ...workflowSpec, graph: options.graph ?? workflowSpec.graph });
    await createMission(location, mission);
    const run = await startRun(location, mission.id, options.prompt ?? '', {
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.sessionControlHost !== undefined ? { sessionControlHost: options.sessionControlHost } : {}),
    });
    return { location, runId: run.id };
}

export async function settleNoninteractiveWorkflowRun(
    handle: NoninteractiveWorkflowRunHandle | undefined,
    outcome: WorkflowRunOutcome,
    attachment?: RunSessionOwnerAttachment,
): Promise<void> {
    if (handle === undefined) return;
    if (attachment !== undefined) {
        await settleNoninteractiveWorkflowRunWithOwner(handle, outcome, attachment);
        return;
    }
    switch (outcome.status) {
        case 'completed':
            await completeRun(handle.location, handle.runId);
            return;
        case 'failed':
            await failRun(handle.location, handle.runId, outcome.reason ?? 'run failed');
            return;
        case 'blocked':
            await blockRun(handle.location, handle.runId);
            return;
        case 'cancelled':
            await cancelRun(handle.location, handle.runId, outcome.reason);
            return;
        default:
            return assertUnreachable(outcome, 'workflow Run outcome');
    }
}

export async function settleNoninteractiveWorkflowRunWithOwner(
    handle: NoninteractiveWorkflowRunHandle | undefined,
    outcome: WorkflowRunOutcome,
    attachment: RunSessionOwnerAttachment,
): Promise<void> {
    if (handle === undefined) return;
    switch (outcome.status) {
        case 'completed':
        case 'blocked':
            await settleMissionRunSessionOwner(handle.location, handle.runId, attachment, { status: outcome.status });
            return;
        case 'failed':
            await settleMissionRunSessionOwner(handle.location, handle.runId, attachment, {
                status: 'failed',
                reason: outcome.reason ?? 'run failed',
            });
            return;
        case 'cancelled':
            await settleMissionRunSessionOwner(handle.location, handle.runId, attachment, outcome);
            return;
        default:
            return assertUnreachable(outcome, 'workflow Run outcome');
    }
}

export function workflowOutcomeFromOwnerStatus(
    status: 'completed' | 'blocked' | 'failed' | 'cancelled',
): WorkflowRunOutcome {
    switch (status) {
        case 'completed':
            return { status: 'completed' };
        case 'blocked':
            return { status: 'blocked' };
        case 'failed':
            return { status: 'failed', reason: 'workflow turn failed' };
        case 'cancelled':
            return { status: 'cancelled', reason: 'workflow turn cancelled' };
        default:
            return assertUnreachable(status, 'workflow Run outcome');
    }
}

export function workflowOutcomeFromGraphStatus(status: AbgGraphStatus, reason: string | undefined): WorkflowRunOutcome {
    switch (status) {
        case 'created':
        case 'active':
            return { status: 'failed', reason: `graph settled non-terminally as ${status}` };
        case 'blocked':
            return { status: 'blocked', reason: reason ?? 'approval required' };
        case 'completed':
            return { status: 'completed' };
        case 'failed':
            return { status: 'failed', reason: reason ?? 'workflow graph run failed' };
        case 'cancelled':
            return { status: 'cancelled', reason: reason ?? 'workflow graph run cancelled' };
        default:
            return assertUnreachable(status, 'workflow Run outcome');
    }
}
