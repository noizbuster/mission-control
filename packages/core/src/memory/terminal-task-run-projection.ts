import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { SessionProjectionRunRecord } from './session-projection-types';

export function terminalTaskRunRecords(input: {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): readonly SessionProjectionRunRecord[] {
    return input.envelopes.flatMap((envelope) => {
        const event = envelope.event;
        const run = event.run;
        if ((event.type !== 'task.completed' && event.type !== 'task.failed') || run?.runId === undefined) {
            return [];
        }
        return [
            {
                kind: 'run',
                sessionId: input.sessionId,
                eventId: envelope.eventId,
                sequence: envelope.sequence,
                timestamp: event.timestamp,
                eventType: event.type,
                ...(run.command !== undefined ? { command: run.command } : {}),
                ...(run.state !== undefined ? { state: run.state } : {}),
                runId: run.runId,
                ...(run.inputId !== undefined ? { inputId: run.inputId } : {}),
                ...(run.providerTurnId !== undefined ? { providerTurnId: run.providerTurnId } : {}),
                ...(run.reason !== undefined ? { reason: run.reason } : {}),
                ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
            },
        ];
    });
}
