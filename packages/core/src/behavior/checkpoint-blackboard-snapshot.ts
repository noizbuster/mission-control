import { redactCredentialText } from '../providers/redaction-handler';

export const CHECKPOINT_BLACKBOARD_TURN_LOCAL_KEYS = ['llm.loop_active', 'llm.soft_landed'] as const;

const turnLocalKeySet = new Set<string>(CHECKPOINT_BLACKBOARD_TURN_LOCAL_KEYS);

/**
 * Durable checkpoint blackboard policy.
 *
 * Keep all graph routing/output entries by default (for example `plan.ready`,
 * `intent.classification`, `delegate.results`, `final.verdict`, workflow counters,
 * and child-session retry state). Strip only documented turn-local LLM control keys:
 * `llm.loop_active` and `llm.soft_landed`. Those keys describe the just-finished
 * provider/tool turn, and resume must use `queuedNodeIds` instead of reviving a
 * stale self-edge.
 *
 * Accepted v1 limits: this builder only snapshots `Blackboard.toRecord()` entries.
 * ModelMessage history is not in that record, and loop-safety reset/resume policy
 * is owned by the coordinator checkpoint wiring, not by this value builder.
 */
export function buildCheckpointBlackboardEntries(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (turnLocalKeySet.has(key)) {
            continue;
        }
        entries[key] = redactCheckpointValue(value);
    }
    return entries;
}

function redactCheckpointValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return redactCredentialText(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactCheckpointValue(entry));
    }
    if (isPlainRecord(value)) {
        const entries: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            entries[key] = redactCheckpointValue(entry);
        }
        return entries;
    }
    return value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
