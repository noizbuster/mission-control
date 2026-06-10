import type { ProtocolError } from '@mission-control/protocol';
import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError } from '../provider-turn-types.js';
import { OpenAIResponsesEventParseError } from './openai-responses-events.js';
import { OpenAIResponsesTransportError } from './openai-responses-transport.js';

export type OpenAIResponsesErrorRedactor = (text: string) => string;

export function mapOpenAIProviderError(error: unknown, resolver: ProviderCredentialResolver): ProtocolError {
    if (error instanceof ProviderTurnError) {
        return error.error;
    }
    if (error instanceof OpenAIResponsesEventParseError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof OpenAIResponsesTransportError) {
        return protocolErrorFromTransportError(error, resolver);
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

function protocolErrorFromTransportError(
    error: OpenAIResponsesTransportError,
    resolver: ProviderCredentialResolver,
): ProtocolError {
    const message = resolver.redactForOutput(error.message);
    if (error.kind === 'abort') {
        return { code: 'provider_aborted', message, retryable: false };
    }
    if (error.kind === 'timeout') {
        return { code: 'provider_timeout', message, retryable: true };
    }
    if (error.status === 401 || error.status === 403) {
        return { code: 'provider_auth_failed', message, retryable: false };
    }
    if (error.status === 429) {
        return { code: 'provider_rate_limited', message, retryable: true };
    }
    if (error.code === 'context_length_exceeded' || message.includes('context_length_exceeded')) {
        return { code: 'provider_context_overflow', message, retryable: false };
    }
    return { code: 'unknown', message, retryable: false };
}

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
