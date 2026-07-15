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
import { createObservabilityRedactor } from '../../providers/observability-redactor';
import { REDACTED_CREDENTIAL } from '../../providers/redaction-handler';

export const MCP_REDACTED_SECRET = REDACTED_CREDENTIAL;

export type SecretRedactor = {
    readonly redactText: (text: string) => string;
    readonly redactValue: (value: unknown) => unknown;
};

export function createSecretRedactor(secrets: readonly string[]): SecretRedactor {
    return createObservabilityRedactor({ secrets });
}
