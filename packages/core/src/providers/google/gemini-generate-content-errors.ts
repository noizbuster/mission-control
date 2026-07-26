import type { ProtocolError } from '@mission-control/protocol';
import { ZodError } from 'zod';
import type { ProviderCredentialResolver } from '../credential-resolver';
import { ProviderTurnError } from '../provider-turn-types';
import { GeminiGenerateContentEventParseError } from './gemini-generate-content-events';
import { GeminiGenerateContentTransportError } from './gemini-generate-content-transport';
import { type ProviderTransportErrorOptions, mapProviderTransportError } from '../shared/provider-transport-error';

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
        return mapProviderTransportError(error, resolver.redactForOutput(error.message), GEMINI_TRANSPORT_ERROR_OPTIONS);
    }
    return { code: 'unknown', message: resolver.redactForOutput(String(error)), retryable: false };
}

const GEMINI_TRANSPORT_ERROR_OPTIONS: ProviderTransportErrorOptions = {
    authStatusCodes: [401, 403],
    authCodes: ['UNAUTHENTICATED'],
    rateLimitStatusCodes: [429, 502, 503, 504, 529],
    rateLimitOn5xx: true,
    rateLimitCodes: ['RESOURCE_EXHAUSTED'],
    rateLimitMessageSubstrings: ['overloaded', 'try again later'],
    timeoutCodes: ['DEADLINE_EXCEEDED'],
    contextOverflow: (info, message) => info.status === 400 && message.includes('context'),
};
