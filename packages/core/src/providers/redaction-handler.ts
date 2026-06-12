import type { RedactionMetadata } from '@mission-control/protocol';

export const REDACTED_CREDENTIAL = '[REDACTED_CREDENTIAL]';

const DEFAULT_REDACTION_REASON = 'token-like provider credential redacted';
const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END_PATTERN = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

type CredentialPattern = {
    readonly pattern: RegExp;
    readonly replacement: string;
};

const DEFAULT_CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
    {
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        replacement: REDACTED_CREDENTIAL,
    },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, replacement: REDACTED_CREDENTIAL },
    { pattern: /\bghp_[A-Za-z0-9_]{10,}\b/g, replacement: REDACTED_CREDENTIAL },
    { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACTED_CREDENTIAL },
    { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{10,}\b/gi, replacement: `$1 ${REDACTED_CREDENTIAL}` },
    {
        pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
        replacement: REDACTED_CREDENTIAL,
    },
    { pattern: /\bAIza[0-9A-Za-z_-]{10,}\b/g, replacement: REDACTED_CREDENTIAL },
    { pattern: /\bsk-[A-Za-z0-9_-]{6,}\b/g, replacement: REDACTED_CREDENTIAL },
];

export function redactCredentialText(text: string, secrets: readonly string[] = []): string {
    const exactRedacted = secrets
        .filter((secret) => secret.length > 0)
        .reduce((current, secret) => current.split(secret).join(REDACTED_CREDENTIAL), text);

    return DEFAULT_CREDENTIAL_PATTERNS.reduce(
        (current, credentialPattern) => current.replace(credentialPattern.pattern, credentialPattern.replacement),
        exactRedacted,
    );
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
