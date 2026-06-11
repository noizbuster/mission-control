import type { ProtocolError } from '@mission-control/protocol';
import { ZodError } from 'zod';
import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError } from '../provider-turn-types.js';
import { AnthropicMessagesEventParseError } from './anthropic-messages-events.js';
import { AnthropicMessagesTransportError } from './anthropic-messages-transport.js';

export type AnthropicMessagesErrorRedactor = (text: string) => string;

export function mapAnthropicProviderError(error: unknown, resolver: ProviderCredentialResolver): ProtocolError {
    if (error instanceof ProviderTurnError) {
        return error.error;
    }
    if (error instanceof AnthropicMessagesEventParseError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof ZodError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof AnthropicMessagesTransportError) {
        return protocolErrorFromTransportError(error, resolver);
    }
    return { code: 'unknown', message: resolver.redactForOutput(String(error)), retryable: false };
}

export function protocolErrorFromAnthropicError(
    error: unknown,
    redactForOutput: AnthropicMessagesErrorRedactor,
): ProtocolError {
    if (isAnthropicErrorRecord(error)) {
        return protocolErrorForCode(error.type, error.message, redactForOutput);
    }
    return { code: 'unknown', message: 'Anthropic Messages stream failed', retryable: false };
}

function protocolErrorFromTransportError(
    error: AnthropicMessagesTransportError,
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
    if (error.status === 429 || error.status === 529) {
        return { code: 'provider_rate_limited', message, retryable: true };
    }
    if (error.code === 'context_length_exceeded' || message.includes('context_length_exceeded')) {
        return { code: 'provider_context_overflow', message, retryable: false };
    }
    return { code: 'unknown', message, retryable: false };
}

function protocolErrorForCode(
    code: string | undefined,
    message: string | undefined,
    redactForOutput: AnthropicMessagesErrorRedactor,
): ProtocolError {
    const redactedMessage = redactForOutput(message ?? 'Anthropic Messages stream failed');
    switch (code) {
        case 'authentication_error':
        case 'permission_error':
            return { code: 'provider_auth_failed', message: redactedMessage, retryable: false };
        case 'rate_limit_error':
        case 'overloaded_error':
            return { code: 'provider_rate_limited', message: redactedMessage, retryable: true };
        case 'request_too_large':
            return { code: 'provider_context_overflow', message: redactedMessage, retryable: false };
        default:
            return { code: 'unknown', message: redactedMessage, retryable: false };
    }
}

function isAnthropicErrorRecord(value: unknown): value is { readonly type?: string; readonly message?: string } {
    return typeof value === 'object' && value !== null;
}
