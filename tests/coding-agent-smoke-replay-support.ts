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

function isRecord(value: unknown): value is {
    readonly kind?: unknown;
    readonly event?: unknown;
    readonly step?: unknown;
} {
    return typeof value === 'object' && value !== null;
}
