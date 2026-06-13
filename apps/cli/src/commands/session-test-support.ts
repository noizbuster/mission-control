import { JsonlSessionEventStore, type ProviderAdapter, type ProviderTurnRequest } from '@mission-control/core';
import { type AgentEvent, AgentEventSchema, type ProviderStreamChunk } from '@mission-control/protocol';

export type ReplayRecord =
    | { readonly kind: 'event'; readonly event: AgentEvent }
    | { readonly kind: 'coding.step'; readonly step: unknown }
    | { readonly kind: 'diagnostic'; readonly diagnostic: unknown };

type ReplayRecordCandidate = {
    readonly kind?: unknown;
    readonly event?: unknown;
    readonly step?: unknown;
    readonly diagnostic?: unknown;
};

export function parseReplayRecords(output: string): readonly ReplayRecord[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => replayRecordFromUnknown(JSON.parse(line)));
}

export function eventRecords(records: readonly ReplayRecord[]): readonly AgentEvent[] {
    return records.flatMap((record) => (record.kind === 'event' ? [record.event] : []));
}

export function codingStepRecords(records: readonly ReplayRecord[]): readonly unknown[] {
    return records.flatMap((record) => (record.kind === 'coding.step' ? [record.step] : []));
}

export function diagnosticRecords(records: readonly ReplayRecord[]): readonly unknown[] {
    return records.flatMap((record) => (record.kind === 'diagnostic' ? [record.diagnostic] : []));
}

export async function writeSessionEvents(input: {
    readonly dataDir: string;
    readonly sessionId: string;
    readonly events: readonly AgentEvent[];
}): Promise<void> {
    const store = await JsonlSessionEventStore.open({
        sessionId: input.sessionId,
        dataDir: input.dataDir,
        now: () => '2026-06-05T10:00:00.000Z',
        createEventId: (event, sequence) => `${input.sessionId}_${sequence}_${event.type.replaceAll('.', '_')}`,
    });
    try {
        for (const event of input.events) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

export function providerFromPatchRequests(): ProviderAdapter {
    let turns = 0;
    return {
        async *streamTurn(request) {
            turns += 1;
            if (turns === 1) {
                yield toolCallChunk(request, 'session_patch_call', 'file.patch', {
                    patch: addFilePatch('.mctrl-known-safe-automation-patch.txt', 'replayed'),
                });
                yield completedChunk(request, 'patch requested', ['session_patch_call']);
                return;
            }
            yield completedChunk(request, 'patch applied after replay');
        },
    };
}

function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

function replayRecordFromUnknown(value: unknown): ReplayRecord {
    if (!isRecord(value)) {
        throw new TypeError('replay record must be an object');
    }
    switch (value.kind) {
        case 'event':
            return { kind: 'event', event: AgentEventSchema.parse(value.event) };
        case 'coding.step':
            return { kind: 'coding.step', step: value.step };
        case 'diagnostic':
            return { kind: 'diagnostic', diagnostic: value.diagnostic };
        default:
            throw new TypeError(`unsupported replay record kind: ${String(value.kind)}`);
    }
}

function isRecord(value: unknown): value is ReplayRecordCandidate {
    return typeof value === 'object' && value !== null;
}
