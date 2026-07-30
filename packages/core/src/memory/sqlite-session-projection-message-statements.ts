import type { AgentEventEnvelope } from '@mission-control/protocol';
import type { MissionControlDrizzleDb } from '../db/drizzle-client';
import { sessionMessages, sessionParts } from '../db/schema';
import { projectSessionReplay } from '../session-replay';
import type { CodingReplayStep } from '../session-replay-types';

export async function projectMessageStatements(
    db: MissionControlDrizzleDb,
    envelopes: readonly AgentEventEnvelope[],
): Promise<void> {
    const projection = projectSessionReplay({ sessionId: envelopes[0]?.sessionId ?? 'missing', envelopes });
    const sequenceByEventId = new Map(envelopes.map((envelope) => [envelope.eventId, envelope.sequence]));
    for (const step of projection.codingSteps) {
        await insertMessageForStep(db, projection.sessionId, step, sequenceByEventId);
    }
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

async function insertMessageForStep(
    db: MissionControlDrizzleDb,
    sessionId: string,
    step: CodingReplayStep,
    sequenceByEventId: ReadonlyMap<string, number>,
): Promise<void> {
    if (step.kind !== 'provider.message') return;
    const sequence = sequenceByEventId.get(step.eventId);
    if (sequence === undefined) return;
    await db.insert(sessionMessages).values({
        messageId: step.messageId,
        sessionId,
        seq: sequence,
        role: 'assistant',
        providerMessageId: step.messageId,
        createdAt: step.timestamp,
        metadataJson: JSON.stringify({
            eventId: step.eventId,
            providerTurnId: step.providerTurnId ?? null,
            continuation: step.continuation,
        }),
    });
    await db.insert(sessionParts).values({
        partId: `${step.messageId}:text:0`,
        messageId: step.messageId,
        sessionId,
        partIndex: 0,
        kind: 'text',
        text: step.message,
        payloadJson: null,
        createdAt: step.timestamp,
    });
}
