import { REDACTED_CREDENTIAL, redactCredentialText } from '../providers/credential-resolver.js';

const COMPACTION_SUMMARY_PATTERNS: readonly {
    readonly pattern: RegExp;
    readonly replacement: string;
}[] = [
    {
        pattern: /(Authorization\s*:\s*)([^\n\r]+)/gi,
        replacement: `$1${REDACTED_CREDENTIAL}`,
    },
    {
        pattern: /(\b(?:X-API-Key|X-Auth-Token|Api-Key)\s*:\s*)([^\n\r]+)/gi,
        replacement: `$1${REDACTED_CREDENTIAL}`,
    },
    {
        pattern:
            /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[=:]\s*)([^\s,;]+)/gi,
        replacement: `$1${REDACTED_CREDENTIAL}`,
    },
];

export function sanitizeCompactionSummary(summary: string): string {
    return COMPACTION_SUMMARY_PATTERNS.reduce(
        (current, rule) => current.replace(rule.pattern, rule.replacement),
        redactCredentialText(summary),
    );
}
