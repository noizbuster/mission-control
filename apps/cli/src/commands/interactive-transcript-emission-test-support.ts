import type { ToolInvocationSettlement } from '@mission-control/core';
import { AgentEventEnvelopeSchema, ProviderStreamChunkSchema, ToolResultSchema } from '@mission-control/protocol';

const timestamp = '2026-07-17T00:00:00.000Z';

export function providerEnvelope(chunkInput: unknown) {
    const chunk = ProviderStreamChunkSchema.parse(chunkInput);
    return AgentEventEnvelopeSchema.parse({
        eventId: `event-${chunk.requestId}-${chunk.sequence}`,
        sequence: chunk.sequence,
        createdAt: timestamp,
        sessionId: 'session-transcript',
        durability: 'ephemeral',
        event: {
            type: 'task.progress',
            timestamp,
            providerStreamChunk: chunk,
        },
    });
}

type CompletedSettlementInput = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly modelOutput: string;
    readonly structuredOutput?: unknown;
};

export function completedSettlement(input: CompletedSettlementInput): ToolInvocationSettlement {
    return {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        result: ToolResultSchema.parse({
            toolCallId: input.toolCallId,
            status: 'completed',
            output: input.modelOutput,
        }),
        ...(input.structuredOutput !== undefined ? { structuredOutput: input.structuredOutput } : {}),
        modelOutput: {
            content: input.modelOutput,
            truncated: false,
            originalLength: input.modelOutput.length,
            limit: 8_192,
        },
        events: [],
    };
}
