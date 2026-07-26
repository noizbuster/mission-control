import type { ProtocolError } from '@mission-control/protocol';
import type { ProviderCredentialResolver } from '../credential-resolver';
import { ProviderTurnError } from '../provider-turn-types';
import { OpenAIResponsesEventParseError } from './openai-responses-events';
import { OpenAIResponsesTransportError } from './openai-responses-transport';
import { type ProviderTransportErrorOptions, mapProviderTransportError } from '../shared/provider-transport-error';

export type OpenAIResponsesErrorRedactor = (text: string) => string;

export function mapOpenAIProviderError(error: unknown, resolver: ProviderCredentialResolver): ProtocolError {
    if (error instanceof ProviderTurnError) {
        return error.error;
    }
    if (error instanceof OpenAIResponsesEventParseError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof OpenAIResponsesTransportError) {
        return mapProviderTransportError(error, resolver.redactForOutput(error.message), OPENAI_TRANSPORT_ERROR_OPTIONS);
    }
    return { code: 'unknown', message: resolver.redactForOutput(String(error)), retryable: false };
}

export function protocolErrorFromOpenAIError(
    error: unknown,
    redactForOutput: OpenAIResponsesErrorRedactor,
): ProtocolError {
    if (isOpenAIErrorRecord(error)) {
        const code = error.code ?? '';
        if (code === 'context_length_exceeded') {
            return {
                code: 'provider_context_overflow',
                message: redactedMessage(error.message, code, redactForOutput),
                retryable: false,
            };
        }
        if (code === 'rate_limit_exceeded') {
            return {
                code: 'provider_rate_limited',
                message: redactedMessage(error.message, code, redactForOutput),
                retryable: true,
            };
        }
        return {
            code: 'unknown',
            message: redactedMessage(error.message, 'OpenAI Responses stream failed', redactForOutput),
            retryable: false,
        };
    }
    return { code: 'unknown', message: 'OpenAI Responses stream failed', retryable: false };
}

const OPENAI_TRANSPORT_ERROR_OPTIONS: ProviderTransportErrorOptions = {
    authStatusCodes: [401, 403],
    rateLimitStatusCodes: [429, 502, 503, 504, 529],
    rateLimitOn5xx: true,
    rateLimitMessageSubstrings: ['overloaded', 'try again later'],
    contextOverflow: (info, message) =>
        info.code === 'context_length_exceeded' || message.includes('context_length_exceeded'),
};

function isOpenAIErrorRecord(value: unknown): value is { readonly code?: string; readonly message?: string } {
    return typeof value === 'object' && value !== null;
}

function redactedMessage(
    message: string | undefined,
    fallback: string,
    redactForOutput: OpenAIResponsesErrorRedactor,
): string {
    return redactForOutput(message ?? fallback);
}
