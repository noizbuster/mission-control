import type { ProtocolError } from '@mission-control/protocol';
import { ZodError } from 'zod';
import type { ProviderCredentialResolver } from '../credential-resolver';
import { ProviderTurnError } from '../provider-turn-types';
import { OpenAICompatibleEventParseError } from './openai-compatible-events';
import { OpenAICompatibleTransportError } from './openai-compatible-transport';

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
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = resolver.redactForOutput(rawMessage);
    if (isTransportNetworkMessage(`${error instanceof Error ? error.name : ''}: ${rawMessage}`)) {
        return { code: 'provider_timeout', message, retryable: true };
    }
    return { code: 'unknown', message, retryable: false };
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
    if (code === 'rate_limit_exceeded' || code === 'overloaded_error' || code === 'overloaded' || code === 'server_error') {
        return { code: 'provider_rate_limited', message, retryable: true };
    }
    if (isTransientOverloadMessage(message)) {
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
    if (error.kind === 'timeout' || error.kind === 'network') {
        return { code: 'provider_timeout', message, retryable: true };
    }
    if (error.status === 401 || error.status === 403) {
        return { code: 'provider_auth_failed', message, retryable: false };
    }
    if (error.status === 429 || isTransientHttpStatus(error.status) || isTransientOverloadMessage(message)) {
        return { code: 'provider_rate_limited', message, retryable: true };
    }
    if (error.code === 'context_length_exceeded' || message.includes('context_length_exceeded')) {
        return { code: 'provider_context_overflow', message, retryable: false };
    }
    if (isTransportNetworkMessage(message)) {
        return { code: 'provider_timeout', message, retryable: true };
    }
    return { code: 'unknown', message, retryable: false };
}

function isTransportNetworkMessage(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes('fetch failed') ||
        lower.includes('network request failed') ||
        lower.includes('socket hang up') ||
        lower.includes('connection reset') ||
        lower.includes('connection refused') ||
        lower.includes('econnreset') ||
        lower.includes('econnrefused') ||
        lower.includes('enotfound') ||
        lower.includes('etimedout') ||
        lower.includes('und_err_')
    );
}

function isTransientHttpStatus(status: number | undefined): boolean {
    return status === 502 || status === 503 || status === 504 || status === 529
        || (status !== undefined && status >= 500 && status < 600);
}

function isTransientOverloadMessage(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes('temporarily overloaded')
        || lower.includes('service may be temporarily overloaded')
        || lower.includes('overloaded')
        || lower.includes('try again later')
        || lower.includes('too many requests')
    );
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
