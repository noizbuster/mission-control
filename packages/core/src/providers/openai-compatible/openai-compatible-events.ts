import { ZodError, z } from 'zod';
import type {
    OpenAICompatibleChoice,
    OpenAICompatibleStreamEvent,
    OpenAICompatibleUsage,
} from './openai-compatible-event-schemas.js';
import { ErrorEventSchema, OpenAICompatibleStreamEventSchema } from './openai-compatible-event-schemas.js';

export type {
    OpenAICompatibleChoice,
    OpenAICompatibleStreamEvent,
    OpenAICompatibleUsage,
} from './openai-compatible-event-schemas.js';

export function parseOpenAICompatibleStreamEvent(value: unknown): OpenAICompatibleStreamEvent {
    const error = ErrorEventSchema.safeParse(value);
    if (error.success) {
        return {
            type: 'error',
            error: {
                ...(error.data.error.code !== undefined ? { code: error.data.error.code } : {}),
                ...(error.data.error.message !== undefined ? { message: error.data.error.message } : {}),
                ...(error.data.error.type !== undefined ? { type: error.data.error.type } : {}),
            },
        };
    }

    try {
        const event = OpenAICompatibleStreamEventSchema.parse(value);
        return {
            type: 'chunk',
            ...(event.id !== undefined ? { id: event.id } : {}),
            choices: event.choices.map(normalizeChoice),
            ...(event.usage !== undefined ? { usage: normalizeUsage(event.usage) } : {}),
        };
    } catch (error_) {
        if (error_ instanceof ZodError) {
            throw new OpenAICompatibleEventParseError(error_.message);
        }
        throw error_;
    }
}

function normalizeChoice(
    choice: z.infer<typeof OpenAICompatibleStreamEventSchema>['choices'][number],
): OpenAICompatibleChoice {
    return {
        index: choice.index,
        delta: {
            ...(choice.delta.content !== undefined ? { content: choice.delta.content } : {}),
            ...(choice.delta.tool_calls !== undefined ? { tool_calls: choice.delta.tool_calls } : {}),
        },
        ...(choice.finish_reason !== undefined ? { finish_reason: choice.finish_reason } : {}),
    };
}

function normalizeUsage(usage: OpenAICompatibleUsage): OpenAICompatibleUsage {
    return {
        ...(usage.prompt_tokens !== undefined ? { prompt_tokens: usage.prompt_tokens } : {}),
        ...(usage.completion_tokens !== undefined ? { completion_tokens: usage.completion_tokens } : {}),
        ...(usage.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
    };
}

export class OpenAICompatibleEventParseError extends Error {
    readonly name = 'OpenAICompatibleEventParseError';
}
