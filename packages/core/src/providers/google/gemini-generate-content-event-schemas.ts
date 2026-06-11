import { z } from 'zod';

const UsageMetadataSchema = z
    .object({
        promptTokenCount: z.number().int().nonnegative().optional(),
        candidatesTokenCount: z.number().int().nonnegative().optional(),
        totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .passthrough();

const CandidateSchema = z
    .object({
        index: z.number().int().nonnegative().optional(),
        content: z
            .object({
                role: z.string().optional(),
                parts: z.array(z.unknown()).optional(),
            })
            .passthrough()
            .optional(),
        finishReason: z.string().min(1).optional(),
    })
    .passthrough();

export const GeminiGenerateContentEventSchema = z
    .object({
        responseId: z.string().min(1).optional(),
        candidates: z.array(CandidateSchema).optional(),
        usageMetadata: UsageMetadataSchema.optional(),
    })
    .passthrough();

const FunctionCallSchema = z
    .object({
        name: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
        id: z.string().min(1).optional(),
    })
    .passthrough();

export const GeminiFunctionCallPartSchema = z
    .object({
        functionCall: FunctionCallSchema,
    })
    .passthrough();

export const GeminiTextPartSchema = z
    .object({
        text: z.string(),
    })
    .passthrough();

export type GeminiUsageMetadata = {
    readonly promptTokenCount?: number | undefined;
    readonly candidatesTokenCount?: number | undefined;
    readonly totalTokenCount?: number | undefined;
};

export type GeminiCandidate = {
    readonly index?: number | undefined;
    readonly parts: readonly unknown[];
    readonly finishReason?: string | undefined;
};

export type GeminiGenerateContentEvent = {
    readonly responseId?: string | undefined;
    readonly candidates: readonly GeminiCandidate[];
    readonly usageMetadata?: GeminiUsageMetadata;
};

export type GeminiFunctionCallPartData = z.infer<typeof GeminiFunctionCallPartSchema>;
