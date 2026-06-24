import type { ProtocolError } from '@mission-control/protocol';
import { ZodError } from 'zod';
import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError } from '../provider-turn-types.js';
import { OpenAICompatibleEventParseError } from './openai-compatible-events.js';
import { OpenAICompatibleTransportError } from './openai-compatible-transport.js';

export type OpenAICompatibleErrorRedactor = (text: string) => string;

export function mapOpenAICompatibleProviderError(error: unknown, resolver: ProviderCredentialResolver): ProtocolError {
    if (error instanceof ProviderTurnError) {
        return error.error;
    }
    if (error instanceof OpenAICompatibleEventParseError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof ZodError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof OpenAICompatibleTransportError) {
        return protocolErrorFromTransportError(error, resolver);
    }
    return { code: 'unknown', message: resolver.redactForOutput(String(error)), retryable: false };
}

export function protocolErrorFromOpenAICompatibleError(
    error: {
        readonly code?: string | undefined;
        readonly message?: string | undefined;
        readonly type?: string | undefined;
    },
    redactForOutput: OpenAICompatibleErrorRedactor,
): ProtocolError {
    const code = error.code ?? error.type;
    const message = redactForOutput(error.message ?? 'OpenAI-compatible stream failed');
    if (code === 'context_length_exceeded') {
        return { code: 'provider_context_overflow', message, retryable: false };
    }
    if (code === 'rate_limit_exceeded') {
        return { code: 'provider_rate_limited', message, retryable: true };
    }
    if (code === 'authentication_error' || code === 'permission_error' || code === 'invalid_api_key') {
        return { code: 'provider_auth_failed', message, retryable: false };
    }
    return { code: 'unknown', message, retryable: false };
}

function protocolErrorFromTransportError(
    error: OpenAICompatibleTransportError,
    resolver: ProviderCredentialResolver,
): ProtocolError {
    const rawMessage = extractReadableErrorMessage(error.message);
    const message = resolver.redactForOutput(rawMessage);
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

function extractReadableErrorMessage(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) {
        return raw;
    }
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const errorField = parsed['error'];
        if (typeof errorField === 'object' && errorField !== null) {
            const msg = (errorField as Record<string, unknown>)['message'];
            if (typeof msg === 'string' && msg.length > 0) {
                return msg;
            }
        }
        const directMessage = parsed['message'];
        if (typeof directMessage === 'string') {
            return directMessage;
        }
    } catch {}
    return raw;
}
