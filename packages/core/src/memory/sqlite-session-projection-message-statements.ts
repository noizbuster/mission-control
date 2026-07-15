import type { InStatement } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { projectSessionReplay } from '../session-replay';
import type { CodingReplayStep } from '../session-replay-types';

export function messageProjectionStatements(envelopes: readonly AgentEventEnvelope[]): readonly InStatement[] {
    const projection = projectSessionReplay({ sessionId: envelopes[0]?.sessionId ?? 'missing', envelopes });
    const sequenceByEventId = new Map(envelopes.map((envelope) => [envelope.eventId, envelope.sequence]));
    return projection.codingSteps.flatMap((step) =>
        messageStatementsForStep(projection.sessionId, step, sequenceByEventId),
    );
}

export function toolNamesById(envelopes: readonly AgentEventEnvelope[]): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    for (const step of projectSessionReplay({ sessionId: envelopes[0]?.sessionId ?? 'missing', envelopes })
        .codingSteps) {
        if (step.kind === 'provider.tool_call') {
            names.set(step.toolCallId, step.toolName);
        }
    }
    return names;
}

export function toolArgumentsById(envelopes: readonly AgentEventEnvelope[]): ReadonlyMap<string, string> {
    const argumentsById = new Map<string, string>();
    for (const envelope of envelopes) {
        const chunk = envelope.event.providerStreamChunk;
        if (chunk?.kind === 'tool_call_completed') {
            argumentsById.set(chunk.toolCall.toolCallId, chunk.toolCall.argumentsJson);
        }
    }
    return argumentsById;
}

function messageStatementsForStep(
    sessionId: string,
    step: CodingReplayStep,
    sequenceByEventId: ReadonlyMap<string, number>,
): readonly InStatement[] {
    if (step.kind !== 'provider.message') {
        return [];
    }
    const sequence = sequenceByEventId.get(step.eventId);
    if (sequence === undefined) {
        return [];
    }
    return [
        {
            sql: `
                INSERT INTO session_messages (
                    message_id, session_id, seq, role, provider_message_id, created_at, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
                step.messageId,
                sessionId,
                sequence,
                'assistant',
                step.messageId,
                step.timestamp,
                JSON.stringify({
                    eventId: step.eventId,
                    providerTurnId: step.providerTurnId ?? null,
                    continuation: step.continuation,
                }),
            ],
        },
        {
            sql: `
                INSERT INTO session_parts (
                    part_id, message_id, session_id, part_index, kind, text, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
                `${step.messageId}:text:0`,
                step.messageId,
                sessionId,
                0,
                'text',
                step.message,
                null,
                step.timestamp,
            ],
        },
    ];
}
