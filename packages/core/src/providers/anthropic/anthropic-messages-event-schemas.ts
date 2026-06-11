import { z } from 'zod';

export const EventHeaderSchema = z
    .object({
        type: z.string().min(1),
    })
    .passthrough();

const AnthropicUsageSchema = z
    .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
    })
    .passthrough();

export const MessageStartEventSchema = EventHeaderSchema.extend({
    type: z.literal('message_start'),
    message: z
        .object({
            id: z.string().min(1),
            usage: AnthropicUsageSchema.optional(),
        })
        .passthrough(),
});

export const TextContentBlockSchema = z
    .object({
        type: z.literal('text'),
        text: z.string().optional(),
    })
    .passthrough();

export const ToolUseContentBlockSchema = z
    .object({
        type: z.literal('tool_use'),
        id: z.string().min(1),
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough();

const GenericTypedObjectSchema = z
    .object({
        type: z.string().min(1),
    })
    .passthrough();

export const ContentBlockStartEventBaseSchema = EventHeaderSchema.extend({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: GenericTypedObjectSchema,
});

export const TextDeltaSchema = z
    .object({
        type: z.literal('text_delta'),
        text: z.string(),
    })
    .passthrough();

export const InputJsonDeltaSchema = z
    .object({
        type: z.literal('input_json_delta'),
        partial_json: z.string(),
    })
    .passthrough();

export const ContentBlockDeltaEventBaseSchema = EventHeaderSchema.extend({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: GenericTypedObjectSchema,
});

export const ContentBlockStopEventSchema = EventHeaderSchema.extend({
    type: z.literal('content_block_stop'),
    index: z.number().int().nonnegative(),
});

export const MessageDeltaEventSchema = EventHeaderSchema.extend({
    type: z.literal('message_delta'),
    delta: z
        .object({
            stop_reason: z.string().min(1).nullable().optional(),
        })
        .passthrough(),
    usage: AnthropicUsageSchema.optional(),
});

export const MessageStopEventSchema = EventHeaderSchema.extend({
    type: z.literal('message_stop'),
});

export const ErrorEventSchema = EventHeaderSchema.extend({
    type: z.literal('error'),
    error: z
        .object({
            type: z.string().min(1).optional(),
            message: z.string().min(1).optional(),
        })
        .passthrough(),
});

type AnthropicContentBlockStart =
    | {
          readonly type: 'text';
          readonly text?: string;
      }
    | {
          readonly type: 'tool_use';
          readonly id: string;
          readonly name: string;
          readonly input?: Readonly<Record<string, unknown>>;
      }
    | {
          readonly type: string;
      };

type AnthropicContentBlockDelta =
    | {
          readonly type: 'text_delta';
          readonly text: string;
      }
    | {
          readonly type: 'input_json_delta';
          readonly partial_json: string;
      }
    | {
          readonly type: string;
      };

export type AnthropicUsage = {
    readonly input_tokens?: number | undefined;
    readonly output_tokens?: number | undefined;
};

export type MessageStartEvent = {
    readonly type: 'message_start';
    readonly message: {
        readonly id: string;
        readonly usage?: AnthropicUsage;
    };
};

export type ContentBlockStartEvent = {
    readonly type: 'content_block_start';
    readonly index: number;
    readonly content_block: AnthropicContentBlockStart;
};

export type ContentBlockDeltaEvent = {
    readonly type: 'content_block_delta';
    readonly index: number;
    readonly delta: AnthropicContentBlockDelta;
};

export type ContentBlockStopEvent = {
    readonly type: 'content_block_stop';
    readonly index: number;
};

export type MessageDeltaEvent = {
    readonly type: 'message_delta';
    readonly delta: {
        readonly stop_reason?: string | null | undefined;
    };
    readonly usage?: AnthropicUsage;
};

type MessageStopEvent = {
    readonly type: 'message_stop';
};

export type ErrorEvent = {
    readonly type: 'error';
    readonly error: {
        readonly type?: string | undefined;
        readonly message?: string | undefined;
    };
};

export type AnthropicMessagesStreamEvent =
    | MessageStartEvent
    | ContentBlockStartEvent
    | ContentBlockDeltaEvent
    | ContentBlockStopEvent
    | MessageDeltaEvent
    | MessageStopEvent
    | ErrorEvent
    | { readonly type: 'ignored'; readonly sourceType: string };

export type AnthropicToolUseContentBlock = Extract<AnthropicContentBlockStart, { readonly type: 'tool_use' }>;

export type ToolUseContentBlockData = z.infer<typeof ToolUseContentBlockSchema>;
