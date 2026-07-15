import type { ProviderStreamChunk } from '@mission-control/protocol';
import type { ObservabilityRedactor, ObservabilityTextStream } from './observability-redactor';

type TextDelta = Extract<ProviderStreamChunk, { readonly kind: 'text_delta' }>;
type ReasoningDelta = Extract<ProviderStreamChunk, { readonly kind: 'reasoning_delta' }>;
type ToolCallDelta = Extract<ProviderStreamChunk, { readonly kind: 'tool_call_delta' }>;

type StreamLane<Chunk> = {
    readonly stream: ObservabilityTextStream;
    latest: Chunk;
};

export type ProviderStreamObservability = {
    readonly transform: (chunk: ProviderStreamChunk) => readonly ProviderStreamChunk[];
};

export function createProviderStreamObservability(redactor: ObservabilityRedactor): ProviderStreamObservability {
    let textLane: StreamLane<TextDelta> | undefined;
    let reasoningLane: StreamLane<ReasoningDelta> | undefined;
    const toolLanes = new Map<string, StreamLane<ToolCallDelta>>();

    const flushText = (): readonly ProviderStreamChunk[] => {
        if (textLane === undefined) {
            return [];
        }
        const lane = textLane;
        textLane = undefined;
        return lane.stream.flush().map((delta) => ({ ...lane.latest, delta }));
    };
    const flushReasoning = (): readonly ProviderStreamChunk[] => {
        if (reasoningLane === undefined) {
            return [];
        }
        const lane = reasoningLane;
        reasoningLane = undefined;
        return lane.stream.flush().map((delta) => ({ ...lane.latest, delta }));
    };
    const flushTool = (toolCallId: string): readonly ProviderStreamChunk[] => {
        const lane = toolLanes.get(toolCallId);
        if (lane === undefined) {
            return [];
        }
        toolLanes.delete(toolCallId);
        return lane.stream.flush().map((argumentsDelta) => ({ ...lane.latest, argumentsDelta }));
    };
    const flushAll = (): readonly ProviderStreamChunk[] => [
        ...flushText(),
        ...flushReasoning(),
        ...[...toolLanes.keys()].flatMap(flushTool),
    ];

    return {
        transform(chunk) {
            switch (chunk.kind) {
                case 'text_delta': {
                    const lane = textLane ?? { stream: redactor.createTextStream(), latest: chunk };
                    lane.latest = chunk;
                    textLane = lane;
                    return lane.stream.push(chunk.delta).map((delta) => ({ ...chunk, delta }));
                }
                case 'reasoning_delta': {
                    const lane = reasoningLane ?? { stream: redactor.createTextStream(), latest: chunk };
                    lane.latest = chunk;
                    reasoningLane = lane;
                    return lane.stream.push(chunk.delta).map((delta) => ({ ...chunk, delta }));
                }
                case 'tool_call_delta': {
                    const lane = toolLanes.get(chunk.toolCallId) ?? {
                        stream: redactor.createTextStream(),
                        latest: chunk,
                    };
                    lane.latest = chunk;
                    toolLanes.set(chunk.toolCallId, lane);
                    return lane.stream.push(chunk.argumentsDelta).map((argumentsDelta) => ({
                        ...chunk,
                        argumentsDelta,
                    }));
                }
                case 'reasoning_completed':
                    return [...flushReasoning(), chunk];
                case 'tool_call_completed':
                    return [...flushTool(chunk.toolCall.toolCallId), chunk];
                case 'response_completed':
                case 'response_failed':
                    return [...flushAll(), chunk];
                case 'response_started':
                    return [chunk];
                default:
                    return assertNever(chunk);
            }
        },
    };
}

function assertNever(_value: never): never {
    throw new TypeError('Unhandled provider stream chunk');
}
