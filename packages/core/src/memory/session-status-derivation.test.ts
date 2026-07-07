import { describe, expect, it } from 'vitest';
import { projectSessionReplay } from '../session-replay.js';
import { envelope, runEvent, sessionStoppedEvent } from '../session-replay-coding-test-support.js';
import type {
    SessionBackgroundJob,
    SessionLifecycleDerivationInput,
    SessionPendingWait,
} from './session-status-derivation.js';
import { deriveSessionLifecycle } from './session-status-derivation.js';

const SESSION_ID = 'session_status_derivation';

type AwaitingCase = {
    readonly name: string;
    readonly pendingWaits: readonly SessionPendingWait[];
    readonly backgroundJobs: readonly SessionBackgroundJob[];
    readonly expected: ReturnType<typeof deriveSessionLifecycle>;
};

describe('session lifecycle derivation', () => {
    it('characterizes current replay snapshots and derives non-awaiting baseline statuses', () => {
        // Given: current replay inputs for an empty session, an active session, and a stopped session.
        const emptyReplay = projectSessionReplay({ sessionId: SESSION_ID, envelopes: [] });
        const runningReplay = projectSessionReplay({
            sessionId: SESSION_ID,
            envelopes: [envelope(sessionStartedEvent(), 0, 'event_session_started')],
        });
        const stoppedReplay = projectSessionReplay({
            sessionId: SESSION_ID,
            envelopes: [
                envelope(sessionStartedEvent(), 0, 'event_session_started'),
                envelope(sessionStoppedEvent(SESSION_ID), 1, 'event_session_stopped'),
            ],
        });

        // When: the new pure derivation receives baseline non-waiting state.
        const derivedStatuses = [
            deriveSessionLifecycle(input()),
            deriveSessionLifecycle(input({ activeRuns: [{ runId: 'run_active' }] })),
            deriveSessionLifecycle(input({ terminalEvent: { kind: 'stopped' } })),
            deriveSessionLifecycle(input({ terminalEvent: { kind: 'failed', reason: 'provider failed' } })),
        ];

        // Then: current replay snapshot behavior is pinned and the pure baseline statuses are explicit.
        expect([emptyReplay.snapshot.status, runningReplay.snapshot.status, stoppedReplay.snapshot.status]).toEqual([
            'running',
            'running',
            'stopped',
        ]);
        expect(derivedStatuses).toEqual([
            { status: 'idle' },
            { status: 'running' },
            { status: 'stopped' },
            { status: 'failed', displayReason: 'provider failed' },
        ]);
    });

    it.each([
        {
            name: 'approval wait',
            pendingWaits: [approvalWait('approval_patch')],
            backgroundJobs: [],
            expected: {
                status: 'awaiting',
                awaitingReason: 'approval',
                displayReason: 'awaiting approval',
                primaryWaitId: 'approval_patch',
            },
        },
        {
            name: 'explicit user input wait',
            pendingWaits: [userInputWait('input_plan_approval')],
            backgroundJobs: [],
            expected: {
                status: 'awaiting',
                awaitingReason: 'user_input',
                displayReason: 'awaiting user input',
                primaryWaitId: 'input_plan_approval',
            },
        },
        {
            name: 'blocking subagent wait',
            pendingWaits: [subagentWait('job_foreground', 'sync')],
            backgroundJobs: [],
            expected: {
                status: 'awaiting',
                awaitingReason: 'subagent',
                displayReason: 'awaiting subagent',
                primaryWaitId: 'job_foreground',
            },
        },
        {
            name: 'multiple waits priority',
            pendingWaits: [
                subagentWait('job_foreground', 'sync'),
                userInputWait('input_plan_approval'),
                approvalWait('approval_patch'),
            ],
            backgroundJobs: [],
            expected: {
                status: 'awaiting',
                awaitingReason: 'approval',
                displayReason: 'awaiting approval',
                primaryWaitId: 'approval_patch',
            },
        },
        {
            name: 'detached background job not awaiting',
            pendingWaits: [subagentWait('job_background', 'detached')],
            backgroundJobs: [{ jobId: 'job_background', blocking: false, status: 'running' }],
            expected: { status: 'running' },
        },
    ] satisfies readonly AwaitingCase[])('derives $name', ({ pendingWaits, backgroundJobs, expected }) => {
        // Given: a running session with pending waits and job metadata.
        const derivationInput = input({ activeRuns: [{ runId: 'run_active' }], pendingWaits, backgroundJobs });

        // When: the lifecycle is derived for display/storage.
        const derived = deriveSessionLifecycle(derivationInput);

        // Then: the display status follows wait priority and blocking semantics.
        expect(derived).toEqual(expected);
    });

    it('ignores waits after a terminal stopped event', () => {
        // Given: a session with stale pending wait rows after a terminal stop.
        const derivationInput = input({
            terminalEvent: { kind: 'stopped' },
            pendingWaits: [approvalWait('approval_stale')],
            activeRuns: [{ runId: 'run_stale' }],
        });

        // When: the lifecycle is derived.
        const derived = deriveSessionLifecycle(derivationInput);

        // Then: the terminal lifecycle wins over stale waits.
        expect(derived).toEqual({ status: 'stopped' });
    });
});

function input(overrides: Partial<SessionLifecycleDerivationInput> = {}): SessionLifecycleDerivationInput {
    return {
        terminalEvent: { kind: 'none' },
        activeRuns: [],
        pendingWaits: [],
        backgroundJobs: [],
        ...overrides,
    };
}

function approvalWait(waitId: string): SessionPendingWait {
    return { waitId, reason: 'approval', source: { kind: 'approval', approvalId: waitId } };
}

function userInputWait(waitId: string): SessionPendingWait {
    return { waitId, reason: 'user_input', source: { kind: 'operator', inputId: waitId } };
}

function subagentWait(waitId: string, mode: 'sync' | 'detached'): SessionPendingWait {
    return {
        waitId,
        reason: 'subagent',
        source: { kind: 'subagent', jobId: waitId, childSessionId: `child_${waitId}`, mode },
    };
}

function sessionStartedEvent() {
    return runEvent(SESSION_ID, 'run.started', 'run started', {
        command: 'run',
        state: 'running',
        runId: 'run_active',
    });
}
