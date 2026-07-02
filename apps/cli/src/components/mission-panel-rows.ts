/**
 * Pure row-building helpers for the Mission Control panel's Jobs and Agents
 * tabs. Kept in a dedicated non-JSX module so the logic is unit-testable
 * without loading the opentui JSX pragma, and so {@link MissionPanelOverlay}
 * stays under the per-file LOC ceiling.
 *
 * The helpers never mutate job or lifecycle state: they read the public
 * manager surfaces ({@link AsyncJobManager.listJobs},
 * {@link RuntimeAgentRegistry.listVisibleTo}) and project them into flat
 * display rows the overlay renders verbatim.
 */
import type { AgentRef, BackgroundJobHandle, ContinuationState } from '@mission-control/core';

/** Display row for a single background job. */
export type JobPanelRow = {
    readonly id: string;
    readonly label: string;
    readonly status: string;
    readonly detail?: string;
    readonly error?: string;
};

/** Display row for a single tracked agent ref. */
export type AgentPanelRow = {
    readonly id: string;
    readonly label: string;
    readonly status: string;
    readonly detail?: string;
};

const ID_DISPLAY_LIMIT = 18;

/** Truncate long opaque ids (job_/session/agent) for a compact panel column. */
export function truncatePanelId(id: string, limit: number = ID_DISPLAY_LIMIT): string {
    return id.length > limit ? `${id.slice(0, limit)}\u2026` : id;
}

/**
 * Reduce an ISO timestamp to its wall-clock time (HH:MM:SS) for compact
 * panel display. Returns undefined when the input is absent or too short to
 * carry a time component, so callers can omit the detail field entirely.
 */
export function formatPanelTimestamp(iso: string | undefined): string | undefined {
    if (iso === undefined) return undefined;
    if (iso.length < 19) return undefined;
    const time = iso.slice(11, 19);
    return /^\d{2}:\d{2}:\d{2}$/u.test(time) ? time : undefined;
}

/**
 * Project background jobs into panel rows. Each row carries the truncated
 * job + session ids as its label, the raw status string (the overlay colors
 * it via {@link jobStatusColor}), start/end timestamps as detail, and the
 * error message when the job failed.
 */
export function buildJobPanelRows(jobs: readonly BackgroundJobHandle[]): JobPanelRow[] {
    return jobs.map((job) => {
        const label = `${truncatePanelId(job.jobId)} \u00b7 ${truncatePanelId(job.sessionId)}`;
        const start = formatPanelTimestamp(job.startedAt);
        const end = formatPanelTimestamp(job.completedAt);
        const parts: string[] = [];
        if (start !== undefined) parts.push(`start ${start}`);
        if (end !== undefined) parts.push(`end ${end}`);
        const detail = parts.length > 0 ? parts.join(' \u00b7 ') : undefined;
        const row: JobPanelRow = {
            id: job.jobId,
            label,
            status: job.status,
            ...(detail !== undefined ? { detail } : {}),
            ...(job.status === 'failed' && job.error !== undefined ? { error: job.error } : {}),
        };
        return row;
    });
}

/**
 * Project tracked agent refs into panel rows. The label pairs the truncated
 * agent id with its display name; detail prefers the live activity hint and
 * falls back to the agent kind so an idle/parked ref still reads meaningfully.
 */
export function buildAgentPanelRows(refs: readonly AgentRef[]): AgentPanelRow[] {
    return refs.map((ref) => {
        const label = `${truncatePanelId(ref.id)} \u00b7 ${ref.displayName}`;
        const detail = ref.activity ?? ref.kind;
        return {
            id: ref.id,
            label,
            status: ref.status,
            ...(detail !== undefined ? { detail } : {}),
        };
    });
}

/** Terminal color for a background-job status string. */
export function jobStatusColor(status: string): string {
    switch (status) {
        case 'completed':
            return '#26d926';
        case 'failed':
        case 'cancelled':
            return '#ff6b6b';
        case 'running':
            return '#00ffff';
        case 'queued':
            return '#ffaa00';
        default:
            return '#aaaaaa';
    }
}

/** Terminal color for a tracked-agent status string. */
export function agentStatusColor(status: string): string {
    switch (status) {
        case 'running':
            return '#00ffff';
        case 'idle':
            return '#26d926';
        case 'parked':
            return '#ffaa00';
        case 'aborted':
            return '#ff6b6b';
        default:
            return '#aaaaaa';
    }
}

/**
 * Stable inactive-state copy for the Drain tab. The interactive path uses the
 * v1 {@link SessionRunCoordinator}; the V2 {@link RunCoordinatorV2} drain-lane
 * only runs for workflow sessions. This string is asserted verbatim by the
 * drain-continue test contract.
 */
export const DRAIN_TAB_MESSAGE =
    'Drain Lane (RunCoordinatorV2) — Inactive\n' +
    '\n' +
    'Interactive mode uses SessionRunCoordinator (v1).\n' +
    'The V2 drain-lane coordinator is not active in interactive sessions.\n' +
    'It is available for workflow sessions only.';

/** Human-readable label for the inferred terminal reason of a continuation. */
export type ContinuationReasonLabel = 'done_signal' | 'loop_inactive' | 'resumable';

export type ContinuationPanelView = {
    readonly iteration: number;
    readonly loopActive: boolean;
    readonly doneSignal: boolean;
    readonly lastSessionId: string | undefined;
    readonly startedAt: string;
    readonly reason: ContinuationReasonLabel;
};

/**
 * Infer the terminal reason from a {@link ContinuationState}. The persisted
 * state carries no explicit outcome reason (that lives on
 * {@link ContinuationOutcome}, produced only by the driving path this panel
 * never runs), so the label is derived from the observable flags:
 * `doneSignal` is definitive; `!loopActive` means the loop went idle. A state
 * that still has `loopActive && !doneSignal` reads as resumable (it may have
 * been capped at `max_iterations`, but that is unknowable from the state alone
 * since the configured cap is not persisted).
 */
export function deriveContinuationReason(state: ContinuationState): ContinuationReasonLabel {
    if (state.doneSignal) return 'done_signal';
    if (!state.loopActive) return 'loop_inactive';
    return 'resumable';
}

export function buildContinuationPanelView(state: ContinuationState): ContinuationPanelView {
    return {
        iteration: state.iteration,
        loopActive: state.loopActive,
        doneSignal: state.doneSignal,
        lastSessionId: state.lastSessionId,
        startedAt: state.startedAt,
        reason: deriveContinuationReason(state),
    };
}
