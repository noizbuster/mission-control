/**
 * Pure correction payload builder for structured/routing retries
 * (ABG progress contract todo 4; Key Decisions correction transport).
 *
 * Coordinator (todo 5) stores the result in `correctionByNodeId` and threads it
 * as `retryCorrection?: string` into `runLlmActorNode`, which prepends it once
 * to the system assembly path. This module is pure: no I/O, no coordinator
 * mutation, no sleep.
 *
 * Contract:
 * - Always returns a non-empty string (safe fallback when inputs are empty).
 * - Hard-capped at {@link CORRECTION_PAYLOAD_MAX_CHARS} (500).
 * - Includes failure code, allowed labels (or boolean shape note), and short error.
 * - Observed values and free-text fields pass through credential redaction.
 */

import { redactCredentialText } from '../providers/redaction-handler';

/** Hard cap for correction strings prepended into llm-actor system assembly. */
export const CORRECTION_PAYLOAD_MAX_CHARS = 500;

/**
 * Safe non-empty fallback when code/labels/error are all missing.
 * Must never be empty — an empty correction would skip the retry hint.
 */
export const CORRECTION_PAYLOAD_FALLBACK =
    'CORRECTION: previous attempt rejected; emit a valid structured value for this node.';

export type BuildCorrectionPayloadInput = {
    /** Canonical failure code (`invalid_structured_output`, `routing_dead_end`, …). */
    readonly code?: string;
    /** Declared `outputEnum` labels the model must choose from. */
    readonly allowedLabels?: readonly string[];
    /**
     * When true and no labels are provided, note boolean `true|false` as the
     * allowed shape (equals-routed boolean outputKeys).
     */
    readonly booleanShape?: boolean;
    /** Short admission/routing error message (redacted). */
    readonly errorMessage?: string;
    /**
     * Optional observed value that failed admission or caused a dead-end
     * (redacted; never treated as a trusted routing key).
     */
    readonly observedValue?: unknown;
    /** Known secrets to redact from observed/error text. */
    readonly secrets?: readonly string[];
};

/**
 * Build a single-shot correction string for the next llm-actor attempt.
 *
 * @example Todo 5 call sites
 * ```ts
 * // invalid_structured_output re-queue:
 * state.correctionByNodeId.set(
 *   nodeId,
 *   buildCorrectionPayload({
 *     code: 'invalid_structured_output',
 *     allowedLabels: outputEnum,
 *     booleanShape: outputShape === 'boolean',
 *     errorMessage: failure.error.message,
 *   }),
 * );
 *
 * // routing.dead_end re-admit:
 * state.correctionByNodeId.set(
 *   nodeId,
 *   buildCorrectionPayload({
 *     code: 'routing_dead_end',
 *     allowedLabels: outputEnum,
 *     booleanShape: outputShape === 'boolean',
 *     errorMessage: 'no outbound edge matched',
 *     observedValue: blackboard.get(outputKey),
 *   }),
 * );
 *
 * // Thread into run context:
 * // { ...runContext, retryCorrection: state.correctionByNodeId.get(nodeId) }
 * ```
 */
export function buildCorrectionPayload(input: BuildCorrectionPayloadInput = {}): string {
    const secrets = input.secrets ?? [];
    const redact = (text: string): string => redactCredentialText(text, secrets);

    const code = normalizeToken(input.code);
    const allowed = formatAllowed(input.allowedLabels, input.booleanShape === true);
    const error = normalizeMessage(input.errorMessage, redact);
    const observed = formatObserved(input.observedValue, redact);

    const parts: string[] = ['CORRECTION'];
    if (code !== undefined) {
        parts.push(`code=${code}`);
    }
    if (allowed !== undefined) {
        parts.push(`allowed=${allowed}`);
    }
    if (error !== undefined) {
        parts.push(`error=${error}`);
    }
    if (observed !== undefined) {
        parts.push(`observed=${observed}`);
    }

    if (parts.length === 1) {
        return CORRECTION_PAYLOAD_FALLBACK;
    }

    return clampCorrection(parts.join(' '));
}

function normalizeToken(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMessage(
    value: string | undefined,
    redact: (text: string) => string,
): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (trimmed.length === 0) return undefined;
    return redact(trimmed);
}

function formatAllowed(
    labels: readonly string[] | undefined,
    booleanShape: boolean,
): string | undefined {
    if (labels !== undefined) {
        const cleaned = labels
            .map((label) => label.trim())
            .filter((label) => label.length > 0);
        if (cleaned.length > 0) {
            return cleaned.join('|');
        }
    }
    if (booleanShape) {
        return 'true|false';
    }
    return undefined;
}

function formatObserved(
    value: unknown,
    redact: (text: string) => string,
): string | undefined {
    if (value === undefined) return undefined;
    const raw = serializeObserved(value);
    if (raw === undefined || raw.length === 0) return undefined;
    return redact(raw);
}

function serializeObserved(value: unknown): string | undefined {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    if (typeof value === 'symbol') {
        return value.description ?? 'symbol';
    }
    if (typeof value === 'function') {
        return 'function';
    }
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable]';
    }
}

function clampCorrection(text: string): string {
    if (text.length <= CORRECTION_PAYLOAD_MAX_CHARS) {
        return text;
    }
    if (CORRECTION_PAYLOAD_MAX_CHARS <= 1) {
        return text.slice(0, CORRECTION_PAYLOAD_MAX_CHARS);
    }
    return `${text.slice(0, CORRECTION_PAYLOAD_MAX_CHARS - 1)}…`;
}
