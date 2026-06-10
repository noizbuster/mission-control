import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { jsonlStoreError } from './jsonl-errors.js';

export const JSONL_SESSION_LOG_HEADER_KIND = 'mission-control.session-log';
export const JSONL_SESSION_EVENT_RECORD_KIND = 'mission-control.session-event';
export const JSONL_SESSION_LOG_RECORD_VERSION = 1;

export type JsonlSessionLogHeader = {
    readonly kind: typeof JSONL_SESSION_LOG_HEADER_KIND;
    readonly version: typeof JSONL_SESSION_LOG_RECORD_VERSION;
    readonly sessionId: string;
    readonly createdAt: string;
};

export type JsonlSessionEventRecord = {
    readonly kind: typeof JSONL_SESSION_EVENT_RECORD_KIND;
    readonly version: typeof JSONL_SESSION_LOG_RECORD_VERSION;
    readonly event: AgentEventEnvelope;
};

export type ParsedJsonlSessionLog = {
    readonly header: JsonlSessionLogHeader;
    readonly envelopes: readonly AgentEventEnvelope[];
};

type JsonlRecordCandidate = {
    readonly kind?: unknown;
    readonly version?: unknown;
    readonly sessionId?: unknown;
    readonly createdAt?: unknown;
    readonly event?: unknown;
};

export function createJsonlSessionLogHeader(input: {
    readonly sessionId: string;
    readonly createdAt: string;
}): JsonlSessionLogHeader {
    return {
        kind: JSONL_SESSION_LOG_HEADER_KIND,
        version: JSONL_SESSION_LOG_RECORD_VERSION,
        sessionId: input.sessionId,
        createdAt: input.createdAt,
    };
}

export function createJsonlSessionEventRecord(envelope: AgentEventEnvelope): JsonlSessionEventRecord {
    return {
        kind: JSONL_SESSION_EVENT_RECORD_KIND,
        version: JSONL_SESSION_LOG_RECORD_VERSION,
        event: envelope,
    };
}

export function serializeJsonlRecord(record: JsonlSessionLogHeader | JsonlSessionEventRecord): string {
    return `${JSON.stringify(record)}\n`;
}

export function parseJsonlSessionLog(input: {
    readonly contents: string;
    readonly filePath: string;
    readonly sessionId: string;
}): ParsedJsonlSessionLog {
    const lines = input.contents
        .split(/\r?\n/)
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter((entry) => entry.line.trim().length > 0);
    const headerLine = lines.at(0);
    if (headerLine === undefined) {
        throw jsonlStoreError({
            code: 'missing_header',
            message: `JSONL session log ${input.sessionId} is missing a header`,
            sessionId: input.sessionId,
            path: input.filePath,
        });
    }

    const header = parseHeaderRecord(parseJsonLine(headerLine, input), headerLine.lineNumber, input);
    const envelopes: AgentEventEnvelope[] = [];
    let previousSequence = -1;
    const seenEventIds = new Set<string>();

    for (const line of lines.slice(1)) {
        const envelope = parseEventRecord(parseJsonLine(line, input), line.lineNumber, input);
        if (envelope.sequence <= previousSequence) {
            throw corruptLine(input, line.lineNumber, 'event sequence is not strictly increasing');
        }
        if (seenEventIds.has(envelope.eventId)) {
            throw corruptLine(input, line.lineNumber, `duplicate event id ${envelope.eventId}`);
        }
        previousSequence = envelope.sequence;
        seenEventIds.add(envelope.eventId);
        envelopes.push(envelope);
    }

    return { header, envelopes };
}

function parseJsonLine(
    line: { readonly line: string; readonly lineNumber: number },
    input: { readonly filePath: string; readonly sessionId: string },
): unknown {
    try {
        return JSON.parse(line.line);
    } catch (error: unknown) {
        throw corruptLine(input, line.lineNumber, 'is not valid JSON', error);
    }
}

function parseHeaderRecord(
    value: unknown,
    lineNumber: number,
    input: { readonly filePath: string; readonly sessionId: string },
): JsonlSessionLogHeader {
    if (!isRecord(value)) {
        throw invalidHeader(input, lineNumber, 'header is not an object');
    }
    if (value.kind !== JSONL_SESSION_LOG_HEADER_KIND) {
        throw invalidHeader(input, lineNumber, 'header has an invalid kind');
    }
    if (value.version !== JSONL_SESSION_LOG_RECORD_VERSION) {
        throw invalidHeader(input, lineNumber, 'header has an unsupported version');
    }
    if (value.sessionId !== input.sessionId) {
        throw jsonlStoreError({
            code: 'session_mismatch',
            message: `JSONL session log ${input.sessionId} header belongs to ${String(value.sessionId)}`,
            sessionId: input.sessionId,
            path: input.filePath,
            lineNumber,
        });
    }
    if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
        throw invalidHeader(input, lineNumber, 'header is missing createdAt');
    }
    return {
        kind: JSONL_SESSION_LOG_HEADER_KIND,
        version: JSONL_SESSION_LOG_RECORD_VERSION,
        sessionId: input.sessionId,
        createdAt: value.createdAt,
    };
}

function parseEventRecord(
    value: unknown,
    lineNumber: number,
    input: { readonly filePath: string; readonly sessionId: string },
): AgentEventEnvelope {
    if (!isRecord(value)) {
        throw corruptLine(input, lineNumber, 'event record is not an object');
    }
    if (value.kind !== JSONL_SESSION_EVENT_RECORD_KIND) {
        throw corruptLine(input, lineNumber, 'event record has an invalid kind');
    }
    if (value.version !== JSONL_SESSION_LOG_RECORD_VERSION) {
        throw corruptLine(input, lineNumber, 'event record has an unsupported version');
    }
    const parsed = AgentEventEnvelopeSchema.safeParse(value.event);
    if (!parsed.success) {
        throw corruptLine(input, lineNumber, `event envelope is invalid: ${firstSchemaIssue(parsed.error.issues)}`);
    }
    if (parsed.data.sessionId !== input.sessionId || parsed.data.event.sessionId !== input.sessionId) {
        throw jsonlStoreError({
            code: 'session_mismatch',
            message: `JSONL session log ${input.sessionId} contains an event for another session`,
            sessionId: input.sessionId,
            path: input.filePath,
            lineNumber,
        });
    }
    if (parsed.data.durability !== 'durable') {
        throw corruptLine(input, lineNumber, 'event record is not durable');
    }
    return parsed.data;
}

function invalidHeader(
    input: { readonly filePath: string; readonly sessionId: string },
    lineNumber: number,
    message: string,
) {
    return jsonlStoreError({
        code: 'invalid_header',
        message: `Invalid JSONL session log ${input.sessionId} line ${lineNumber}: ${message}`,
        sessionId: input.sessionId,
        path: input.filePath,
        lineNumber,
    });
}

function corruptLine(
    input: { readonly filePath: string; readonly sessionId: string },
    lineNumber: number,
    message: string,
    cause?: unknown,
) {
    return jsonlStoreError({
        code: 'corrupt_line',
        message: `Invalid JSONL session log ${input.sessionId} line ${lineNumber}: ${message}`,
        sessionId: input.sessionId,
        path: input.filePath,
        lineNumber,
        cause,
    });
}

function firstSchemaIssue(issues: readonly { readonly message: string }[]): string {
    return issues.at(0)?.message ?? 'unknown schema issue';
}

function isRecord(value: unknown): value is JsonlRecordCandidate {
    return typeof value === 'object' && value !== null;
}
