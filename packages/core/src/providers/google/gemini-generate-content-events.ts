import type {
    GeminiCandidate,
    GeminiFunctionCallPartData,
    GeminiGenerateContentEvent,
    GeminiUsageMetadata,
} from './gemini-generate-content-event-schemas.js';
import {
    GeminiFunctionCallPartSchema,
    GeminiGenerateContentEventSchema,
    GeminiTextPartSchema,
} from './gemini-generate-content-event-schemas.js';

export type {
    GeminiCandidate,
    GeminiGenerateContentEvent,
    GeminiUsageMetadata,
} from './gemini-generate-content-event-schemas.js';

export type GeminiParsedFunctionCall = {
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly id?: string;
};

export function parseGeminiGenerateContentEvent(value: unknown): GeminiGenerateContentEvent {
    const parsed = GeminiGenerateContentEventSchema.parse(value);
    return {
        ...(parsed.responseId !== undefined ? { responseId: parsed.responseId } : {}),
        candidates: (parsed.candidates ?? []).map((candidate): GeminiCandidate => {
            return {
                ...(candidate.index !== undefined ? { index: candidate.index } : {}),
                parts: candidate.content?.parts ?? [],
                ...(candidate.finishReason !== undefined ? { finishReason: candidate.finishReason } : {}),
            };
        }),
        ...(parsed.usageMetadata !== undefined ? { usageMetadata: usageMetadata(parsed.usageMetadata) } : {}),
    };
}

export function parseGeminiFunctionCallPart(value: unknown): GeminiParsedFunctionCall | undefined {
    if (!hasField(value, 'functionCall')) {
        return undefined;
    }
    return normalizeFunctionCallPart(GeminiFunctionCallPartSchema.parse(value));
}

export function parseGeminiTextPart(value: unknown): string | undefined {
    const parsed = GeminiTextPartSchema.safeParse(value);
    return parsed.success ? parsed.data.text : undefined;
}

function normalizeFunctionCallPart(part: GeminiFunctionCallPartData): GeminiParsedFunctionCall {
    return {
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
        ...(part.functionCall.id !== undefined ? { id: part.functionCall.id } : {}),
    };
}

function usageMetadata(usage: GeminiUsageMetadata): GeminiUsageMetadata {
    return {
        ...(usage.promptTokenCount !== undefined ? { promptTokenCount: usage.promptTokenCount } : {}),
        ...(usage.candidatesTokenCount !== undefined ? { candidatesTokenCount: usage.candidatesTokenCount } : {}),
        ...(usage.totalTokenCount !== undefined ? { totalTokenCount: usage.totalTokenCount } : {}),
    };
}

function hasField(value: unknown, field: string): boolean {
    return typeof value === 'object' && value !== null && field in value;
}

export class GeminiGenerateContentEventParseError extends Error {
    readonly name = 'GeminiGenerateContentEventParseError';
}
