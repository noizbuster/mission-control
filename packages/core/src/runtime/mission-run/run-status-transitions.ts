import type { RunStatus } from '@mission-control/protocol';

export const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
    pending: ['running'],
    running: ['blocked', 'completed', 'failed', 'cancelled'],
    blocked: ['running'],
    completed: [],
    failed: [],
    cancelled: [],
};

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

export class MissionRunTransitionError extends Error {
    constructor(
        message: string,
        readonly fromStatus: RunStatus,
        readonly toStatus: RunStatus,
    ) {
        super(message);
        this.name = 'MissionRunTransitionError';
    }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
    if (from === to) {
        return;
    }
    const allowed = ALLOWED_RUN_TRANSITIONS[from];
    if (!allowed.includes(to)) {
        throw new MissionRunTransitionError(`Invalid run status transition: ${from} -> ${to}`, from, to);
    }
}
