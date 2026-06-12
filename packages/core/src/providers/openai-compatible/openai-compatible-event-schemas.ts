import { z } from 'zod';

const UsageSchema = z
    .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
    })
    .passthrough();

const FunctionDeltaSchema = z
    .object({
        name: z.string().min(1).optional(),
        arguments: z.string().optional(),
    })
    .passthrough();

export const ToolCallDeltaSchema = z
    .object({
        index: z.number().int().nonnegative(),
        id: z.string().min(1).optional(),
        type: z.literal('function').optional(),
        function: FunctionDeltaSchema.optional(),
    })
    .passthrough();

const DeltaSchema = z
    .object({
        role: z.string().optional(),
        content: z.string().nullable().optional(),
        tool_calls: z.array(ToolCallDeltaSchema).optional(),
    })
    .passthrough();

const ChoiceSchema = z
    .object({
        index: z.number().int().nonnegative(),
        delta: DeltaSchema.default({}),
        finish_reason: z.string().nullable().optional(),
    })
    .passthrough();

export const OpenAICompatibleStreamEventSchema = z
    .object({
        id: z.string().min(1).optional(),
        choices: z.array(ChoiceSchema).default([]),
        usage: UsageSchema.optional(),
    })
    .passthrough();

export const ErrorEventSchema = z
    .object({
        error: z
            .object({
                code: z.string().min(1).optional(),
                message: z.string().min(1).optional(),
                type: z.string().min(1).optional(),
            })
            .passthrough(),
    })
    .passthrough();

export type OpenAICompatibleUsage = {
    readonly prompt_tokens?: number | undefined;
    readonly completion_tokens?: number | undefined;
    readonly total_tokens?: number | undefined;
};

export type OpenAICompatibleToolCallDelta = z.infer<typeof ToolCallDeltaSchema>;

export type OpenAICompatibleChoice = {
    readonly index: number;
    readonly delta: {
        readonly content?: string | null | undefined;
        readonly tool_calls?: readonly OpenAICompatibleToolCallDelta[] | undefined;
    };
    readonly finish_reason?: string | null | undefined;
};

export type OpenAICompatibleStreamEvent =
    | {
          readonly type: 'chunk';
          readonly id?: string | undefined;
          readonly choices: readonly OpenAICompatibleChoice[];
          readonly usage?: OpenAICompatibleUsage | undefined;
      }
    | {
          readonly type: 'error';
          readonly error: {
              readonly code?: string | undefined;
              readonly message?: string | undefined;
              readonly type?: string | undefined;
          };
      };
