/**
 * Secret redaction for MCP client output. The values mission-control hands to a spawned MCP
 * server (expanded `environment` / header secrets) must never echo back into tool results,
 * events, JSONL, CLI output, or error messages. This redactor is constructed from the known
 * secret values and string-replaces each with a fixed mask, longest-first so a shorter secret
 * that is a substring of a longer one cannot corrupt the longer one's replacement.
 *
 * Unrelated MCP server output is NOT scrubbed here: it is untrusted external DATA, bounded by
 * the tool's output cap. Only the secrets mission-control itself injected are masked.
 */
export const MCP_REDACTED_SECRET = '[REDACTED]';

export type SecretRedactor = {
    readonly redactText: (text: string) => string;
    readonly redactValue: (value: unknown) => unknown;
};

export function createSecretRedactor(secrets: readonly string[]): SecretRedactor {
    const ordered = uniqueNonEmptySecrets(secrets);
    const redactText = (text: string): string => {
        let current = text;
        for (const secret of ordered) {
            if (current.length === 0) {
                break;
            }
            if (current.includes(secret)) {
                current = current.split(secret).join(MCP_REDACTED_SECRET);
            }
        }
        return current;
    };
    return {
        redactText,
        redactValue: (value) => redactValueRecursive(value, redactText),
    };
}

function uniqueNonEmptySecrets(secrets: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    const collected: string[] = [];
    for (const secret of secrets) {
        if (typeof secret !== 'string' || secret.length === 0) {
            continue;
        }
        if (seen.has(secret)) {
            continue;
        }
        seen.add(secret);
        collected.push(secret);
    }
    return collected.sort((left, right) => right.length - left.length);
}

function redactValueRecursive(value: unknown, redactText: (text: string) => string): unknown {
    if (typeof value === 'string') {
        return redactText(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactValueRecursive(entry, redactText));
    }
    if (isPlainObject(value)) {
        const next: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            next[key] = redactValueRecursive(entry, redactText);
        }
        return next;
    }
    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
