import type { ProviderCredential, ProviderToolCallTranscript } from '@mission-control/protocol';
import { ProviderCredentialResolutionError, type ProviderCredentialResolver } from '../credential-resolver';
import { ProviderTurnError } from '../provider-turn-types';

/**
 * Guards that a value is a plain record (non-null object that is not an array).
 *
 * Canonical guarded form: the array guard is load-bearing — without it, JSON
 * arrays would satisfy `typeof === 'object'` and be treated as records.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves a required provider credential through {@link resolver}, rethrowing
 * credential-resolution failures as a non-retryable {@link ProviderTurnError}
 * while propagating every other error unchanged.
 *
 * Extracted from the byte-identical `resolve<Provider>Credential` helpers that
 * lived in each provider's request builder; only the resolver boilerplate is
 * shared — the per-provider credential EXTRACTORS (apiKey vs bearer) differ
 * legitimately and remain per-provider.
 */
export async function resolveProviderCredentialFromResolver(
    resolver: ProviderCredentialResolver,
    providerID: string,
): Promise<ProviderCredential> {
    try {
        return await resolver.resolveRequiredProviderCredential({ providerID });
    } catch (error) {
        if (error instanceof ProviderCredentialResolutionError) {
            throw new ProviderTurnError({
                code: 'provider_auth_failed',
                message: error.message,
                retryable: false,
                ...(error.redactions.length > 0 ? { redactions: [...error.redactions] } : {}),
            });
        }
        throw error;
    }
}

/**
 * Spreads a provider response id onto a stream chunk only when present.
 * Returns `{}` for `undefined` so the property is omitted entirely.
 */
export function providerResponseId(providerResponse: string | undefined): { readonly providerResponseId?: string } {
    return providerResponse === undefined ? {} : { providerResponseId: providerResponse };
}

/**
 * Builds the `toolCallIds` / `providerToolCalls` message fields shared by every
 * provider's `response_completed` chunk. Returns `{}` when there are no tool
 * calls so both fields are omitted; otherwise maps the transcript ids and
 * forwards the transcripts.
 */
export function providerToolCallMessageFields(providerToolCalls: readonly ProviderToolCallTranscript[]): {
    readonly toolCallIds?: string[];
    readonly providerToolCalls?: ProviderToolCallTranscript[];
} {
    return providerToolCalls.length === 0
        ? {}
        : {
              toolCallIds: providerToolCalls.map((toolCall) => toolCall.toolCallId),
              providerToolCalls: [...providerToolCalls],
          };
}

/**
 * Builds a tool-input parser that JSON-parses arguments into a record, throwing
 * a non-retryable {@link ProviderTurnError} (code `schema_invalid`) on invalid
 * JSON or a non-object value.
 *
 * `label` prefixes both error messages (e.g. `"${label} is not valid JSON"`),
 * matching the anthropic (`"Anthropic tool input"`) and gemini
 * (`"Gemini function call args"`) copies this replaces.
 */
export function parseJsonObjectToolInput(label: string): (argumentsJson: string) => Readonly<Record<string, unknown>> {
    return (argumentsJson: string): Readonly<Record<string, unknown>> => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(argumentsJson);
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new ProviderTurnError({
                    code: 'schema_invalid',
                    message: `${label} is not valid JSON: ${error.message}`,
                    retryable: false,
                });
            }
            throw error;
        }
        if (isRecord(parsed)) {
            return parsed;
        }
        throw new ProviderTurnError({
            code: 'schema_invalid',
            message: `${label} must be a JSON object`,
            retryable: false,
        });
    };
}
