import type { AgentEvent, AgentEventEnvelope, ProviderStreamChunk } from '@mission-control/protocol';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './memory/jsonl-session-records.js';

export const sessionCompactionTestSessionId = 'session_compaction_test';

export function fixedCompactionNow(): string {
    return '2026-06-13T00:00:00.000Z';
}

export function promptPromoted(inputId: string, messageId: string, message: string): AgentEvent {
    return {
        type: 'prompt.promoted',
        timestamp: '2026-06-13T00:00:01.000Z',
        sessionId: sessionCompactionTestSessionId,
        message,
        transcript: {
            inputId,
            messageId,
            delivery: 'queue',
        },
    };
}

export function providerCompleted(message: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: '2026-06-13T00:00:02.000Z',
        sessionId: sessionCompactionTestSessionId,
        providerStreamChunk: responseCompletedChunk(message),
    };
}

export function compacted(summary: string, firstKeptSequence: number, boundarySequence: number): AgentEvent {
    return {
        type: 'session.compacted',
        timestamp: '2026-06-13T00:00:03.000Z',
        sessionId: sessionCompactionTestSessionId,
        message: 'compacted older history',
        sessionTree: {
            kind: 'compaction',
            boundaryEntryId: `event_${boundarySequence}`,
            firstKeptEntryId: `event_${firstKeptSequence}`,
            summary,
            firstKeptSequence,
            boundarySequence,
        },
    };
}

export function responseCompletedChunk(message: string): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: 'request_compaction',
        sequence: 1,
        message: {
            messageId: `assistant_${message.replaceAll(' ', '_')}`,
            role: 'assistant',
            content: message,
        },
        finishReason: 'stop',
    };
}

export function validReplayContents(envelopes: readonly AgentEventEnvelope[], sortBySequence = true): string {
    const ordered = sortBySequence ? [...envelopes].sort((left, right) => left.sequence - right.sequence) : envelopes;
    return [
        serializeJsonlRecord(
            createJsonlSessionLogHeader({
                sessionId: sessionCompactionTestSessionId,
                createdAt: fixedCompactionNow(),
            }),
        ),
        ...ordered.map((item) => serializeJsonlRecord(createJsonlSessionEventRecord(item))),
    ].join('');
}

export function envelope(sequence: number, event: AgentEvent): AgentEventEnvelope {
    return {
        eventId: `event_${sequence}`,
        sequence,
        createdAt: fixedCompactionNow(),
        sessionId: sessionCompactionTestSessionId,
        durability: 'durable',
        event,
    };
}
