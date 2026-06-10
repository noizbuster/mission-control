import { z } from 'zod';

const EventHeaderSchema = z
    .object({
        type: z.string().min(1),
        sequence_number: z.number().int().nonnegative().optional(),
    })
    .passthrough();

const ResponseReferenceSchema = z
    .object({
        id: z.string().min(1),
    })
    .passthrough();

const OpenAIUsageSchema = z
    .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
    })
    .passthrough();

const OutputTextContentSchema = z
    .object({
        type: z.literal('output_text'),
        text: z.string(),
    })
    .passthrough();

const MessageOutputItemSchema = z
    .object({
        id: z.string().min(1).optional(),
        type: z.literal('message'),
        role: z.literal('assistant'),
        content: z.array(z.unknown()),
    })
    .passthrough();

const FunctionCallItemSchema = z
    .object({
        id: z.string().min(1),
        type: z.literal('function_call'),
        call_id: z.string().min(1).optional(),
        name: z.string().min(1),
        arguments: z.string(),
    })
    .passthrough();

const ResponseCreatedEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.created'),
    response: ResponseReferenceSchema,
});

const TextDeltaEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.output_text.delta'),
    response_id: z.string().min(1).optional(),
    delta: z.string(),
});

const OutputItemAddedEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.output_item.added'),
    response_id: z.string().min(1).optional(),
    output_index: z.number().int().nonnegative(),
    item: z.unknown(),
});

const OutputItemDoneEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.output_item.done'),
    response_id: z.string().min(1).optional(),
    output_index: z.number().int().nonnegative(),
    item: z.unknown(),
});

const FunctionArgumentsDeltaEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.function_call_arguments.delta'),
    response_id: z.string().min(1).optional(),
    item_id: z.string().min(1),
    output_index: z.number().int().nonnegative(),
    delta: z.string(),
});

const FunctionArgumentsDoneEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.function_call_arguments.done'),
    response_id: z.string().min(1).optional(),
    item_id: z.string().min(1),
    output_index: z.number().int().nonnegative(),
    arguments: z.string(),
    name: z.string().min(1).optional(),
});

const ResponseCompletedEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.completed'),
    response: z
        .object({
            id: z.string().min(1),
            status: z.string().optional(),
            output: z.array(z.unknown()).optional(),
            usage: OpenAIUsageSchema.optional(),
        })
        .passthrough(),
});

const ResponseFailedEventSchema = EventHeaderSchema.extend({
    type: z.literal('response.failed'),
    response: z
        .object({
            id: z.string().min(1).optional(),
            error: z.unknown().optional(),
        })
        .passthrough()
        .optional(),
    error: z.unknown().optional(),
});

const ErrorEventSchema = EventHeaderSchema.extend({
    type: z.literal('error'),
    code: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
});

export type OpenAIResponsesStreamEvent =
    | z.infer<typeof ResponseCreatedEventSchema>
    | z.infer<typeof TextDeltaEventSchema>
    | z.infer<typeof OutputItemAddedEventSchema>
    | z.infer<typeof OutputItemDoneEventSchema>
    | z.infer<typeof FunctionArgumentsDeltaEventSchema>
    | z.infer<typeof FunctionArgumentsDoneEventSchema>
    | z.infer<typeof ResponseCompletedEventSchema>
    | z.infer<typeof ResponseFailedEventSchema>
    | z.infer<typeof ErrorEventSchema>
    | { readonly type: 'ignored'; readonly sourceType: string; readonly sequence_number?: number };

export type OpenAIFunctionCallItem = z.infer<typeof FunctionCallItemSchema>;

export function parseOpenAIResponsesStreamEvent(value: unknown): OpenAIResponsesStreamEvent {
    const header = EventHeaderSchema.safeParse(value);
    if (!header.success) {
        throw new OpenAIResponsesEventParseError('OpenAI Responses stream event requires a type');
    }

    switch (header.data.type) {
        case 'response.created':
            return ResponseCreatedEventSchema.parse(value);
        case 'response.output_text.delta':
            return TextDeltaEventSchema.parse(value);
        case 'response.output_item.added':
            return OutputItemAddedEventSchema.parse(value);
        case 'response.output_item.done':
            return OutputItemDoneEventSchema.parse(value);
        case 'response.function_call_arguments.delta':
            return FunctionArgumentsDeltaEventSchema.parse(value);
        case 'response.function_call_arguments.done':
            return FunctionArgumentsDoneEventSchema.parse(value);
        case 'response.completed':
            return ResponseCompletedEventSchema.parse(value);
        case 'response.failed':
            return ResponseFailedEventSchema.parse(value);
        case 'error':
            return ErrorEventSchema.parse(value);
        default:
            return ignoredEvent(header.data.type, header.data.sequence_number);
    }
}

function ignoredEvent(
    sourceType: string,
    sequenceNumber: number | undefined,
): { readonly type: 'ignored'; readonly sourceType: string; readonly sequence_number?: number } {
    return sequenceNumber === undefined
        ? { type: 'ignored', sourceType }
        : { type: 'ignored', sourceType, sequence_number: sequenceNumber };
}

export function parseOpenAIFunctionCallItem(value: unknown): OpenAIFunctionCallItem | undefined {
    const parsed = FunctionCallItemSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

export function parseOpenAIMessageOutputText(value: unknown): string | undefined {
    const message = MessageOutputItemSchema.safeParse(value);
    if (!message.success) {
        return undefined;
    }
    const parts = message.data.content
        .map((part) => OutputTextContentSchema.safeParse(part))
        .filter((part) => part.success)
        .map((part) => part.data.text);
    return parts.length === 0 ? undefined : parts.join('');
}

export class OpenAIResponsesEventParseError extends Error {
    readonly name = 'OpenAIResponsesEventParseError';
}
