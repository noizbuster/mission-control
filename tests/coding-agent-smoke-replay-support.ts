import { type AgentEvent, AgentEventSchema } from '../packages/protocol/src/index.js';

export function parseEventLines(output: string): readonly AgentEvent[] {
    return output
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .flatMap((line) => eventFromRawOrReplayRecord(JSON.parse(line)));
}

export function parseCodingStepLines(output: string): readonly unknown[] {
    return output
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .flatMap((line) => codingStepFromReplayRecord(JSON.parse(line)));
}

export function parseDiagnosticLines(output: string): readonly ReplayDiagnosticRecord[] {
    return output
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .flatMap((line) => diagnosticFromReplayRecord(JSON.parse(line)));
}

function eventFromRawOrReplayRecord(value: unknown): readonly AgentEvent[] {
    if (!isRecord(value)) {
        return [AgentEventSchema.parse(value)];
    }
    if (value.kind === 'event') {
        return [AgentEventSchema.parse(value.event)];
    }
    if (value.kind === 'coding.step' || value.kind === 'diagnostic') {
        return [];
    }
    return [AgentEventSchema.parse(value)];
}

function codingStepFromReplayRecord(value: unknown): readonly unknown[] {
    if (!isRecord(value) || value.kind !== 'coding.step') {
        return [];
    }
    return [value.step];
}

function diagnosticFromReplayRecord(value: unknown): readonly ReplayDiagnosticRecord[] {
    if (!isRecord(value) || value.kind !== 'diagnostic' || !isReplayDiagnostic(value.diagnostic)) {
        return [];
    }
    return [value.diagnostic];
}

function isRecord(value: unknown): value is {
    readonly kind?: unknown;
    readonly event?: unknown;
    readonly step?: unknown;
    readonly diagnostic?: unknown;
} {
    return typeof value === 'object' && value !== null;
}

type ReplayDiagnosticRecord = {
    readonly code: string;
    readonly sessionId: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly eventId?: string;
    readonly lineNumber?: number;
};

function isReplayDiagnostic(value: unknown): value is ReplayDiagnosticRecord {
    if (!hasStringCodeAndSession(value)) {
        return false;
    }
    return true;
}

function hasStringCodeAndSession(value: unknown): value is {
    readonly code: string;
    readonly sessionId: string;
} {
    return (
        typeof value === 'object' &&
        value !== null &&
        'code' in value &&
        typeof value.code === 'string' &&
        'sessionId' in value &&
        typeof value.sessionId === 'string'
    );
}
