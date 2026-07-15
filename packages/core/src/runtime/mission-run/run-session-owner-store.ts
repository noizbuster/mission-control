import { type Run, RunSchema } from '@mission-control/protocol';
import type { MissionRunStoreLocation } from './mission-run-store-location';
import { RunStoreError } from './run-json-compatibility';
import { mutateStoredRun, type RunPatch, transitionStoredRun } from './run-store';

export type RunSessionOwnerAttachment = {
    readonly sessionId: string;
    readonly sessionRunId: string;
};

export type RunSessionOwnerSettlement =
    | { readonly status: 'blocked' }
    | { readonly status: 'completed' }
    | { readonly status: 'failed'; readonly reason: string }
    | { readonly status: 'cancelled'; readonly reason: string };

export async function attachRunSessionOwner(
    location: MissionRunStoreLocation,
    runId: string,
    attachment: RunSessionOwnerAttachment,
): Promise<Run> {
    return mutateStoredRun(location, runId, (run) => runWithSessionOwner(run, runId, attachment));
}

export async function settleRunSessionOwner(
    location: MissionRunStoreLocation,
    runId: string,
    attachment: RunSessionOwnerAttachment,
    settlement: RunSessionOwnerSettlement,
): Promise<Run> {
    const now = new Date().toISOString();
    return mutateStoredRun(location, runId, (run) =>
        transitionStoredRun(
            runWithSessionOwner(run, runId, attachment),
            settlement.status,
            settlementPatch(settlement),
            now,
        ),
    );
}

function runWithSessionOwner(run: Run, runId: string, attachment: RunSessionOwnerAttachment): Run {
    if (run.sessionId !== attachment.sessionId) {
        throw new RunStoreError(`Run ${runId} belongs to a different session`, 'run_session_mismatch');
    }
    if (run.sessionRunId !== undefined) {
        if (run.sessionRunId === attachment.sessionRunId) return run;
        throw new RunStoreError(
            `Run ${runId} already belongs to a different session owner`,
            'run_session_owner_mismatch',
        );
    }
    if (run.status !== 'running') {
        throw new RunStoreError(
            `Run ${runId} cannot attach a session owner while ${run.status}`,
            'run_session_owner_not_attachable',
        );
    }
    return RunSchema.parse({ ...run, sessionRunId: attachment.sessionRunId });
}

function settlementPatch(settlement: RunSessionOwnerSettlement): RunPatch {
    switch (settlement.status) {
        case 'blocked':
        case 'completed':
            return {};
        case 'failed':
        case 'cancelled':
            return { terminalReason: settlement.reason };
        default:
            return assertNever(settlement);
    }
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected Run session owner settlement: ${String(value)}`);
}
