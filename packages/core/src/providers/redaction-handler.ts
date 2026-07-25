import type { RedactionMetadata } from '@mission-control/protocol';

export const REDACTED_CREDENTIAL = '[REDACTED_CREDENTIAL]';

const DEFAULT_REDACTION_REASON = 'token-like provider credential redacted';
const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END_PATTERN = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

type CredentialPattern = {
    readonly pattern: RegExp;
    readonly replacement: (marker: string) => string;
};

const CREDENTIAL_MARKER_CANDIDATES = [REDACTED_CREDENTIAL, '[MASKED_CREDENTIAL]', '[HIDDEN_CREDENTIAL]', ''] as const;

const DEFAULT_CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
    {
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        replacement: (marker) => marker,
    },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, replacement: (marker) => marker },
    { pattern: /\bghp_[A-Za-z0-9_]{10,}\b/g, replacement: (marker) => marker },
    { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: (marker) => marker },
    { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{10,}\b/gi, replacement: (marker) => `$1 ${marker}` },
    {
        pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
        replacement: (marker) => marker,
    },
    { pattern: /\bAIza[0-9A-Za-z_-]{10,}\b/g, replacement: (marker) => marker },
    { pattern: /\bsk-[A-Za-z0-9_-]{6,}\b/g, replacement: (marker) => marker },
];

export function redactCredentialText(text: string, secrets: readonly string[] = []): string {
    // The empty-secrets redactor is the streaming hot path: eventForProviderChunk calls this
    // on every text_delta/reasoning_delta with the default []. It is deterministic (module-level
    // regex patterns, no per-call state), so reuse the cached closure instead of rebuilding the
    // Set/sort/marker-probe/closures on every token.
    if (secrets.length === 0) return noSecretsCredentialRedactor(text);
    return createCredentialTextRedactor(secrets)(text);
}

export function createCredentialTextRedactor(secrets: readonly string[] = []): (text: string) => string {
    const exactSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
        (left, right) => right.length - left.length,
    );
    const marker =
        CREDENTIAL_MARKER_CANDIDATES.find((candidate) => exactSecrets.every((secret) => !candidate.includes(secret))) ??
        '';
    const redactExact = createExactSecretTextRedactor(exactSecrets, marker);
    const redactSegment = (segment: string): string => {
        const exactRedacted = redactExact(segment);
        return DEFAULT_CREDENTIAL_PATTERNS.reduce(
            (current, credentialPattern) =>
                current.replace(credentialPattern.pattern, credentialPattern.replacement(marker)),
            exactRedacted,
        );
    };
    if (marker.length === 0) {
        return redactSegment;
    }
    return (value) =>
        value
            .split(marker)
            .map((segment) => redactSegment(segment))
            .join(marker);
}
// Deterministic empty-secrets redactor, built once. Safe to share: redactSegment only uses
// String.replace over module-level global-flag patterns (no lastIndex state across calls).
const noSecretsCredentialRedactor = createCredentialTextRedactor([]);

export function createExactSecretTextRedactor(
    secrets: readonly string[],
    replacement?: string,
): (text: string) => string {
    const exactSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
        (left, right) => right.length - left.length,
    );
    const marker =
        replacement ??
        CREDENTIAL_MARKER_CANDIDATES.find((candidate) => exactSecrets.every((secret) => !candidate.includes(secret))) ??
        '';
    return (text) => exactSecrets.reduce((current, secret) => current.split(secret).join(marker), text);
}

export type RedactedCredentialLine = {
    readonly text: string;
    readonly redacted: boolean;
};

export function redactCredentialLines(lines: readonly string[]): readonly RedactedCredentialLine[] {
    let insidePrivateKeyBlock = false;
    return lines.map((line) => {
        const startsPrivateKeyBlock = PRIVATE_KEY_BEGIN_PATTERN.test(line);
        const redactsPrivateKeyBlock = insidePrivateKeyBlock || startsPrivateKeyBlock;
        const endsPrivateKeyBlock = PRIVATE_KEY_END_PATTERN.test(line);
        if (redactsPrivateKeyBlock) {
            insidePrivateKeyBlock = !endsPrivateKeyBlock;
            return { text: REDACTED_CREDENTIAL, redacted: true };
        }

        const redacted = redactCredentialText(line);
        return { text: redacted, redacted: redacted !== line };
    });
}

export function credentialRedactionsForText(
    text: string,
    secrets: readonly string[] = [],
): readonly RedactionMetadata[] {
    const knownRedactions = createCredentialRedactions(secrets);
    if (knownRedactions.length > 0) {
        return knownRedactions;
    }
    if (!containsDefaultCredentialPattern(text)) {
        return [];
    }
    return [
        {
            classification: 'credential',
            reason: DEFAULT_REDACTION_REASON,
            replacement: REDACTED_CREDENTIAL,
        },
    ];
}

export function createCredentialRedactions(secrets: readonly string[]): readonly RedactionMetadata[] {
    return secrets
        .filter((secret) => secret.length > 0)
        .map(() => ({
            classification: 'credential',
            reason: 'provider credential redacted',
            replacement: REDACTED_CREDENTIAL,
        }));
}

function containsDefaultCredentialPattern(text: string): boolean {
    return DEFAULT_CREDENTIAL_PATTERNS.some((credentialPattern) => {
        credentialPattern.pattern.lastIndex = 0;
        const matched = credentialPattern.pattern.test(text);
        credentialPattern.pattern.lastIndex = 0;
        return matched;
    });
}
