import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
} from '@mission-control/protocol';
import { OBSERVABILITY_UNAVAILABLE, type ObservabilityRedactor } from './observability-value-redactor';

export function redactAgentEventForObservability(event: AgentEvent, redactor: ObservabilityRedactor): AgentEvent {
    const parsed = AgentEventSchema.safeParse(redactor.redactValue(event));
    return parsed.success ? parsed.data : fallbackEvent(event, redactor);
}

export function redactAgentEventEnvelopeForObservability(
    envelope: AgentEventEnvelope,
    redactor: ObservabilityRedactor,
): AgentEventEnvelope {
    const parsed = AgentEventEnvelopeSchema.safeParse(redactor.redactValue(envelope));
    if (parsed.success) {
        return parsed.data;
    }
    return AgentEventEnvelopeSchema.parse({
        eventId: safeIdentifier(envelope.eventId, redactor),
        sequence: envelope.sequence,
        createdAt: envelope.createdAt,
        sessionId: safeIdentifier(envelope.sessionId, redactor),
        durability: envelope.durability,
        ...(envelope.causationId !== undefined ? { causationId: safeIdentifier(envelope.causationId, redactor) } : {}),
        ...(envelope.correlationId !== undefined
            ? { correlationId: safeIdentifier(envelope.correlationId, redactor) }
            : {}),
        event: fallbackEvent(envelope.event, redactor),
    });
}

function fallbackEvent(event: AgentEvent, redactor: ObservabilityRedactor): AgentEvent {
    const base = {
        type: event.type,
        timestamp: event.timestamp,
        message: OBSERVABILITY_UNAVAILABLE,
        ...(event.sessionId !== undefined ? { sessionId: safeIdentifier(event.sessionId, redactor) } : {}),
        ...(event.taskId !== undefined ? { taskId: safeIdentifier(event.taskId, redactor) } : {}),
    } satisfies AgentEvent;
    if (event.type === 'prompt.cancelled') {
        return AgentEventSchema.parse({
            ...base,
            transcript: {
                inputId: safeIdentifier(event.transcript?.inputId ?? '', redactor),
                requestId: safeIdentifier(event.transcript?.requestId ?? '', redactor),
                delivery: event.transcript?.delivery ?? 'queue',
                reason: 'operator_aborted',
            },
        });
    }
    if (event.type === 'session.abort.completed') {
        return AgentEventSchema.parse({
            ...base,
            sessionStop: {
                operationId: safeIdentifier(event.sessionStop?.operationId ?? '', redactor),
                requestId: safeIdentifier(event.sessionStop?.requestId ?? '', redactor),
                reason: 'operator_aborted',
                affected: event.sessionStop?.affected ?? {
                    runs: 0,
                    approvals: 0,
                    sessionAwaits: 0,
                    sessionInputs: 0,
                    missionRuns: 0,
                    asyncJobs: 0,
                    toolCalls: 0,
                },
            },
        });
    }
    if (event.type === 'run.interrupted' && event.run?.reason === 'operator_aborted') {
        return AgentEventSchema.parse({
            ...base,
            run: {
                state: 'interrupted',
                requestId: safeIdentifier(event.run.requestId ?? '', redactor),
                operationId: safeIdentifier(event.run.operationId ?? '', redactor),
                reason: 'operator_aborted',
            },
        });
    }
    return AgentEventSchema.parse(base);
}

function safeIdentifier(identifier: string, redactor: ObservabilityRedactor): string {
    const redacted = redactor.redactIdentifier(identifier);
    return redacted.length > 0 ? redacted : OBSERVABILITY_UNAVAILABLE;
}
