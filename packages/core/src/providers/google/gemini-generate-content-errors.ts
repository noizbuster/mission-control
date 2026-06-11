import type { ProtocolError } from '@mission-control/protocol';
import { ZodError } from 'zod';
import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError } from '../provider-turn-types.js';
import { GeminiGenerateContentEventParseError } from './gemini-generate-content-events.js';
import { GeminiGenerateContentTransportError } from './gemini-generate-content-transport.js';

export function mapGeminiProviderError(error: unknown, resolver: ProviderCredentialResolver): ProtocolError {
    if (error instanceof ProviderTurnError) {
        return error.error;
    }
    if (error instanceof GeminiGenerateContentEventParseError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof ZodError) {
        return { code: 'schema_invalid', message: resolver.redactForOutput(error.message), retryable: false };
    }
    if (error instanceof GeminiGenerateContentTransportError) {
        return protocolErrorFromTransportError(error, resolver);
    }
    return { code: 'unknown', message: resolver.redactForOutput(String(error)), retryable: false };
}

function protocolErrorFromTransportError(
    error: GeminiGenerateContentTransportError,
    resolver: ProviderCredentialResolver,
): ProtocolError {
    const message = resolver.redactForOutput(error.message);
    if (error.kind === 'abort') {
        return { code: 'provider_aborted', message, retryable: false };
    }
    if (error.kind === 'timeout') {
        return { code: 'provider_timeout', message, retryable: true };
    }
    if (error.status === 401 || error.status === 403 || error.code === 'UNAUTHENTICATED') {
        return { code: 'provider_auth_failed', message, retryable: false };
    }
    if (error.status === 429 || error.code === 'RESOURCE_EXHAUSTED') {
        return { code: 'provider_rate_limited', message, retryable: true };
    }
    if (error.code === 'DEADLINE_EXCEEDED') {
        return { code: 'provider_timeout', message, retryable: true };
    }
    if (error.status === 400 && message.includes('context')) {
        return { code: 'provider_context_overflow', message, retryable: false };
    }
    return { code: 'unknown', message, retryable: false };
}
