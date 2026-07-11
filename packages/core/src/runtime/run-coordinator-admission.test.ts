import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { projectRunCoordinatorAdmission } from './run-coordinator-admission.js';

const SESSION_ID = 'session_run_admission_cancelled';

describe('run coordinator admission projection', () => {
    it('excludes a cancelled transcript admission from restart promotion', () => {
        const projection = projectRunCoordinatorAdmission(
            [admittedEvent('input_transcript'), cancelledEvent('input_transcript')],
            SESSION_ID,
        );

        expect(projection.pendingInputs).toEqual([]);
        expect(projection.queuedInputs).toEqual([]);
    });

    it('excludes a cancelled run-command admission from restart promotion', () => {
        const projection = projectRunCoordinatorAdmission(
            [runCommandEvent('input_command'), cancelledEvent('input_command')],
            SESSION_ID,
        );

        expect(projection.pendingInputs).toEqual([]);
        expect(projection.steeringInputs).toEqual([]);
    });
});

function admittedEvent(inputId: string): AgentEvent {
    return {
        type: 'prompt.admitted',
        timestamp: '2026-07-11T10:00:00.000Z',
        sessionId: SESSION_ID,
        message: 'queued prompt',
        transcript: {
            inputId,
            messageId: `message_${inputId}`,
            delivery: 'queue',
            visibility: 'pending',
        },
    };
}

function runCommandEvent(inputId: string): AgentEvent {
    return {
        type: 'run.command.received',
        timestamp: '2026-07-11T10:00:00.000Z',
        sessionId: SESSION_ID,
        message: 'steering prompt',
        run: {
            command: 'steer',
            state: 'running',
            inputId,
            messageId: `message_${inputId}`,
            delivery: 'steer',
        },
    };
}

function cancelledEvent(inputId: string): AgentEvent {
    return {
        type: 'prompt.cancelled',
        timestamp: '2026-07-11T10:00:01.000Z',
        sessionId: SESSION_ID,
        transcript: {
            inputId,
            delivery: inputId === 'input_command' ? 'steer' : 'queue',
            requestId: 'request_stop',
            reason: 'operator_aborted',
        },
    };
}
