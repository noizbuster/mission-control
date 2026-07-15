import {
    composeObservabilityTextStreams,
    createObservabilityTextStream,
    type ObservabilityTextStream,
} from './observability-text-stream';
import { OBSERVABILITY_UNAVAILABLE, redactObservabilityValue } from './observability-value-traversal';
import { createCredentialTextRedactor, createExactSecretTextRedactor } from './redaction-handler';

export const OBSERVABILITY_REDACTION_MAX_BYTES = 64 * 1024;
export const OBSERVABILITY_REDACTION_MAX_DEPTH = 16;
export const OBSERVABILITY_REDACTION_MAX_ENTRIES = 4_096;
export const OBSERVABILITY_TRUNCATED = '[TRUNCATED]';
export const OBSERVABILITY_CIRCULAR = '[CIRCULAR]';
export { OBSERVABILITY_UNAVAILABLE };

export type ObservabilityRedactor = {
    readonly redactText: (text: string) => string;
    readonly redactIdentifier: (identifier: string) => string;
    readonly redactValue: (value: unknown) => unknown;
    readonly createTextStream: () => ObservabilityTextStream;
};

export type ObservabilityRedactorOptions = {
    readonly secrets?: readonly string[];
    readonly textRedactors?: readonly ((text: string) => string)[];
    readonly maxBytes?: number;
    readonly maxDepth?: number;
    readonly maxEntries?: number;
};

type RedactionLimits = {
    readonly maxBytes: number;
    readonly maxDepth: number;
    readonly maxEntries: number;
};

export function createObservabilityRedactor(options: ObservabilityRedactorOptions = {}): ObservabilityRedactor {
    const secrets = [...new Set((options.secrets ?? []).filter((secret) => secret.length > 0))];
    const textRedactors = options.textRedactors ?? [];
    const redactCredentials = createCredentialTextRedactor(secrets);
    const redactKnownIdentifier = createExactSecretTextRedactor(secrets);
    const limits: RedactionLimits = {
        maxBytes: normalizeLimit(options.maxBytes, OBSERVABILITY_REDACTION_MAX_BYTES, 32),
        maxDepth: normalizeLimit(options.maxDepth, OBSERVABILITY_REDACTION_MAX_DEPTH, 0),
        maxEntries: normalizeLimit(options.maxEntries, OBSERVABILITY_REDACTION_MAX_ENTRIES, 1),
    };
    const redactText = (text: string): string =>
        redactCredentials(textRedactors.reduce((current, redact) => redact(current), text));
    const redactIdentifier = (identifier: string): string => redactKnownIdentifier(identifier);
    return {
        redactText,
        redactIdentifier,
        redactValue: (value) =>
            redactObservabilityValue(value, {
                ...limits,
                circularMarker: OBSERVABILITY_CIRCULAR,
                truncatedMarker: OBSERVABILITY_TRUNCATED,
                redactText,
                redactIdentifier,
            }),
        createTextStream: () =>
            createObservabilityTextStream({
                redactText,
                secrets,
                maxBufferBytes: limits.maxBytes,
            }),
    };
}

export function composeObservabilityRedactors(redactors: readonly ObservabilityRedactor[]): ObservabilityRedactor {
    if (redactors.length === 0) {
        return createObservabilityRedactor();
    }
    return {
        redactText: (text) => redactors.reduce((current, redactor) => redactor.redactText(current), text),
        redactIdentifier: (identifier) =>
            redactors.reduce((current, redactor) => redactor.redactIdentifier(current), identifier),
        redactValue: (value) => redactors.reduce((current, redactor) => redactor.redactValue(current), value),
        createTextStream: () =>
            composeObservabilityTextStreams(redactors.map((redactor) => redactor.createTextStream())),
    };
}

function normalizeLimit(value: number | undefined, fallback: number, minimum: number): number {
    return value === undefined || !Number.isFinite(value) ? fallback : Math.max(minimum, Math.floor(value));
}

export type { ObservabilityTextStream };
