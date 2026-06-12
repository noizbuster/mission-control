import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    parseJsonlSessionLog,
    serializeJsonlRecord,
} from './jsonl-session-records.js';

describe('parseJsonlSessionLog', () => {
    it('rejects corrupt JSONL records', () => {
        // Given
        const sessionId = 'session_jsonl_corrupt_record';
        const contents = `${headerLine(sessionId)}{"broken":\n`;

        expectParseError(
            { sessionId, contents },
            { code: 'corrupt_line', lineNumber: 2, message: 'is not valid JSON' },
        );
    });

    it('rejects non-monotonic envelope sequence', () => {
        // Given
        const sessionId = 'session_jsonl_out_of_order';
        const contents = `${headerLine(sessionId)}${eventLine(eventEnvelope({ sessionId, sequence: 1, eventId: 'event_1' }))}${eventLine(eventEnvelope({ sessionId, sequence: 1, eventId: 'event_2' }))}`;

        expectParseError(
            { sessionId, contents },
            { code: 'corrupt_line', lineNumber: 3, message: 'event sequence is not strictly increasing' },
        );
    });

    it('rejects mismatched header session ids', () => {
        // Given
        const sessionId = 'session_jsonl_header_target';
        const contents = headerLine('session_jsonl_header_other');

        expectParseError(
            { sessionId, contents },
            { code: 'session_mismatch', lineNumber: 1, message: 'header belongs to session_jsonl_header_other' },
        );
    });

    it('rejects event session mismatch', () => {
        // Given
        const sessionId = 'session_jsonl_event_target';
        const contents = `${headerLine(sessionId)}${eventLine(eventEnvelope({ sessionId, sequence: 0, eventId: 'event_foreign', eventSessionId: 'session_jsonl_event_other' }))}`;

        expectParseError(
            { sessionId, contents },
            { code: 'session_mismatch', lineNumber: 2, message: 'contains an event for another session' },
        );
    });

    it('rejects duplicate event ids', () => {
        // Given
        const sessionId = 'session_jsonl_duplicate_event';
        const contents = `${headerLine(sessionId)}${eventLine(eventEnvelope({ sessionId, sequence: 0, eventId: 'event_repeat' }))}${eventLine(eventEnvelope({ sessionId, sequence: 1, eventId: 'event_repeat' }))}`;

        expectParseError(
            { sessionId, contents },
            { code: 'corrupt_line', lineNumber: 3, message: 'duplicate event id event_repeat' },
        );
    });

    it('rejects non-durable events', () => {
        // Given
        const sessionId = 'session_jsonl_ephemeral_event';
        const contents = `${headerLine(sessionId)}${eventLine(eventEnvelope({ sessionId, sequence: 0, eventId: 'event_ephemeral', durability: 'ephemeral' }))}`;

        expectParseError(
            { sessionId, contents },
            { code: 'corrupt_line', lineNumber: 2, message: 'event record is not durable' },
        );
    });
});

type Durability = AgentEventEnvelope['durability'];

type EventEnvelopeInput = {
    readonly sessionId: string;
    readonly sequence: number;
    readonly eventId: string;
    readonly durability?: Durability;
    readonly eventSessionId?: string;
};

type ExpectedParseError = {
    readonly code: string;
    readonly lineNumber: number;
    readonly message: string;
};

function expectParseError(
    input: { readonly sessionId: string; readonly contents: string },
    expected: ExpectedParseError,
): void {
    expect(() =>
        parseJsonlSessionLog({
            sessionId: input.sessionId,
            contents: input.contents,
            filePath: `${input.sessionId}.jsonl`,
        }),
    ).toThrow(
        expect.objectContaining({
            code: expected.code,
            lineNumber: expected.lineNumber,
            sessionId: input.sessionId,
            message: expect.stringContaining(expected.message),
        }),
    );
}

function headerLine(sessionId: string): string {
    return serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId, createdAt: '2026-06-05T10:00:00.000Z' }));
}

function eventLine(envelope: AgentEventEnvelope): string {
    return serializeJsonlRecord(createJsonlSessionEventRecord(envelope));
}

function eventEnvelope(input: EventEnvelopeInput): AgentEventEnvelope {
    const eventSessionId = input.eventSessionId ?? input.sessionId;
    return {
        eventId: input.eventId,
        sequence: input.sequence,
        createdAt: '2026-06-05T10:00:01.000Z',
        sessionId: input.sessionId,
        durability: input.durability ?? 'durable',
        event: taskEvent(eventSessionId, input.eventId),
    };
}

function taskEvent(sessionId: string, taskId: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-05T10:00:01.000Z',
        sessionId,
        taskId,
        message: `task completed: ${taskId}`,
        nativeSidecarStatus: 'mock',
    };
}
