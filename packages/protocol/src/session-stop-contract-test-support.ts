export const sessionStopContractTimestamp = '2026-07-10T12:00:00.000Z';

export function promptCancelledEvent() {
    return {
        type: 'prompt.cancelled',
        timestamp: sessionStopContractTimestamp,
        sessionId: 'session_child',
        transcript: {
            inputId: 'input_queued',
            delivery: 'queue',
            requestId: 'request_stop',
            reason: 'operator_aborted',
        },
    };
}

export function abortCompletedEvent(runs = 1) {
    return {
        type: 'session.abort.completed',
        timestamp: sessionStopContractTimestamp,
        sessionId: 'session_child',
        sessionStop: {
            operationId: 'operation_stop',
            requestId: 'request_stop',
            reason: 'operator_aborted',
            affected: {
                runs,
                approvals: 1,
                sessionAwaits: 1,
                sessionInputs: 1,
                missionRuns: 1,
                asyncJobs: 1,
                toolCalls: 1,
            },
        },
    };
}

export function operatorAbortedRunEvent() {
    return {
        type: 'run.interrupted',
        timestamp: sessionStopContractTimestamp,
        sessionId: 'session_child',
        run: {
            state: 'interrupted',
            runId: 'run_active',
            requestId: 'request_stop',
            operationId: 'operation_stop',
            reason: 'operator_aborted',
        },
    };
}

export function correlatedLegacyInterruptedRunEvent() {
    return {
        type: 'run.interrupted',
        timestamp: sessionStopContractTimestamp,
        sessionId: 'session_legacy',
        run: {
            state: 'interrupted',
            requestId: 'request_legacy',
            operationId: 'operation_legacy',
            reason: 'user interrupted run',
        },
    };
}

export function activeStopEventFixture() {
    return [operatorAbortedRunEvent(), abortCompletedEvent()];
}

export function noRunStopEventFixture() {
    return [abortCompletedEvent(0)];
}

export function persistedLegacyEventLog() {
    return JSON.stringify([
        {
            eventId: 'event_prompt_admitted',
            sequence: 1,
            createdAt: sessionStopContractTimestamp,
            sessionId: 'session_legacy',
            durability: 'durable',
            event: {
                type: 'prompt.admitted',
                timestamp: sessionStopContractTimestamp,
                sessionId: 'session_legacy',
                transcript: {
                    inputId: 'input_legacy',
                    delivery: 'queue',
                    visibility: 'pending',
                },
            },
        },
        {
            eventId: 'event_run_interrupted',
            sequence: 2,
            createdAt: sessionStopContractTimestamp,
            sessionId: 'session_legacy',
            durability: 'durable',
            event: {
                type: 'run.interrupted',
                timestamp: sessionStopContractTimestamp,
                sessionId: 'session_legacy',
                run: {
                    state: 'interrupted',
                    runId: 'run_legacy',
                    reason: 'user interrupted run',
                },
            },
        },
    ]);
}
