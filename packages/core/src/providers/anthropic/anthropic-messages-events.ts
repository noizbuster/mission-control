import type {
    AnthropicMessagesStreamEvent,
    AnthropicToolUseContentBlock,
    AnthropicUsage,
    ContentBlockDeltaEvent,
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    ErrorEvent,
    MessageDeltaEvent,
    MessageStartEvent,
    ToolUseContentBlockData,
} from './anthropic-messages-event-schemas.js';
import {
    ContentBlockDeltaEventBaseSchema,
    ContentBlockStartEventBaseSchema,
    ContentBlockStopEventSchema,
    ErrorEventSchema,
    EventHeaderSchema,
    InputJsonDeltaSchema,
    MessageDeltaEventSchema,
    MessageStartEventSchema,
    MessageStopEventSchema,
    TextContentBlockSchema,
    TextDeltaSchema,
    ToolUseContentBlockSchema,
} from './anthropic-messages-event-schemas.js';

export type {
    AnthropicMessagesStreamEvent,
    AnthropicToolUseContentBlock,
} from './anthropic-messages-event-schemas.js';

export function parseAnthropicMessagesStreamEvent(value: unknown): AnthropicMessagesStreamEvent {
    const header = EventHeaderSchema.safeParse(value);
    if (!header.success) {
        throw new AnthropicMessagesEventParseError('Anthropic Messages stream event requires a type');
    }

    switch (header.data.type) {
        case 'message_start':
            return parseMessageStartEvent(value);
        case 'content_block_start':
            return parseContentBlockStartEvent(value);
        case 'content_block_delta':
            return parseContentBlockDeltaEvent(value);
        case 'content_block_stop':
            return parseContentBlockStopEvent(value);
        case 'message_delta':
            return parseMessageDeltaEvent(value);
        case 'message_stop':
            MessageStopEventSchema.parse(value);
            return { type: 'message_stop' };
        case 'error':
            return parseErrorEvent(value);
        default:
            return { type: 'ignored', sourceType: header.data.type };
    }
}

export function parseAnthropicToolUseContentBlock(value: unknown): AnthropicToolUseContentBlock | undefined {
    const parsed = ToolUseContentBlockSchema.safeParse(value);
    return parsed.success ? normalizeToolUseContentBlock(parsed.data) : undefined;
}

function parseContentBlockStartEvent(value: unknown): ContentBlockStartEvent {
    const event = ContentBlockStartEventBaseSchema.parse(value);
    switch (event.content_block.type) {
        case 'text':
            return { ...event, content_block: TextContentBlockSchema.parse(event.content_block) };
        case 'tool_use':
            return {
                ...event,
                content_block: normalizeToolUseContentBlock(ToolUseContentBlockSchema.parse(event.content_block)),
            };
        default:
            return event;
    }
}

function normalizeToolUseContentBlock(block: ToolUseContentBlockData): AnthropicToolUseContentBlock {
    return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        ...(block.input !== undefined ? { input: block.input } : {}),
    };
}

function parseContentBlockDeltaEvent(value: unknown): ContentBlockDeltaEvent {
    const event = ContentBlockDeltaEventBaseSchema.parse(value);
    switch (event.delta.type) {
        case 'text_delta':
            return { ...event, delta: TextDeltaSchema.parse(event.delta) };
        case 'input_json_delta':
            return { ...event, delta: InputJsonDeltaSchema.parse(event.delta) };
        default:
            return event;
    }
}

function parseMessageStartEvent(value: unknown): MessageStartEvent {
    const event = MessageStartEventSchema.parse(value);
    return {
        type: 'message_start',
        message: {
            id: event.message.id,
            ...usageField(event.message.usage),
        },
    };
}

function parseContentBlockStopEvent(value: unknown): ContentBlockStopEvent {
    const event = ContentBlockStopEventSchema.parse(value);
    return { type: 'content_block_stop', index: event.index };
}

function parseMessageDeltaEvent(value: unknown): MessageDeltaEvent {
    const event = MessageDeltaEventSchema.parse(value);
    return {
        type: 'message_delta',
        delta: stopReasonField(event.delta.stop_reason),
        ...usageField(event.usage),
    };
}

function parseErrorEvent(value: unknown): ErrorEvent {
    const event = ErrorEventSchema.parse(value);
    return {
        type: 'error',
        error: {
            ...(event.error.type !== undefined ? { type: event.error.type } : {}),
            ...(event.error.message !== undefined ? { message: event.error.message } : {}),
        },
    };
}

function usageField(usage: AnthropicUsage | undefined): { readonly usage?: AnthropicUsage } {
    return usage === undefined
        ? {}
        : {
              usage: {
                  ...(usage.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
                  ...(usage.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}),
              },
          };
}

function stopReasonField(stopReason: string | null | undefined): { readonly stop_reason?: string | null | undefined } {
    return stopReason === undefined ? {} : { stop_reason: stopReason };
}

export class AnthropicMessagesEventParseError extends Error {
    readonly name = 'AnthropicMessagesEventParseError';
}
