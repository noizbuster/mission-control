/**
 * Context-pressure UX helpers (omo overflow-recovery aligned, TUI-side).
 *
 * The runtime already classifies `provider_context_overflow` as terminal and
 * exposes `/compact`. This module turns usage ratios and overflow error text
 * into operator-facing sticky/transient cues so the dock status and notices
 * point at the recovery action without inventing a second compaction engine.
 */

/** Fill ratio at which the UI warns before a hard overflow. */
export const CONTEXT_PRESSURE_WARN_RATIO = 0.7;
/** Fill ratio at which the UI escalates to a critical sticky notice. */
export const CONTEXT_PRESSURE_CRITICAL_RATIO = 0.9;

export type ContextPressureLevel = 'ok' | 'warn' | 'critical';

export type ContextPressureStatus = {
    readonly level: ContextPressureLevel;
    readonly ratio: number | undefined;
    readonly percent: number | undefined;
    /** Sticky/transient notice copy; undefined when under the warn threshold. */
    readonly notice: string | undefined;
};

const OVERFLOW_MESSAGE_PATTERN =
    /context[\s_-]*(?:window|length)?[\s_-]*(?:exceeded|too large|overflow)|provider_context_overflow|request_too_large|maximum context/iu;

/**
 * Pure view of context fill pressure for status/notice surfaces.
 * `used` may be 0 before the first turn; `max` unknown → ok/undefined.
 */
export function contextPressureStatus(used: number | undefined, max: number | undefined): ContextPressureStatus {
    if (max === undefined || !(max > 0) || !Number.isFinite(max)) {
        return { level: 'ok', ratio: undefined, percent: undefined, notice: undefined };
    }
    const safeUsed = used === undefined || !Number.isFinite(used) || used < 0 ? 0 : used;
    const ratio = safeUsed / max;
    const percent = Math.round(ratio * 100);
    if (ratio >= CONTEXT_PRESSURE_CRITICAL_RATIO) {
        return {
            level: 'critical',
            ratio,
            percent,
            notice: `Context nearly full (${percent}%). Run /compact before the next large turn.`,
        };
    }
    if (ratio >= CONTEXT_PRESSURE_WARN_RATIO) {
        return {
            level: 'warn',
            ratio,
            percent,
            notice: `Context high (${percent}%). Consider /compact to free headroom.`,
        };
    }
    return { level: 'ok', ratio, percent, notice: undefined };
}

/** True when error text looks like a provider context-window overflow. */
export function isContextOverflowMessage(message: string): boolean {
    if (message.length === 0) return false;
    return OVERFLOW_MESSAGE_PATTERN.test(message);
}

/**
 * Sticky recovery cue after a context-overflow failure.
 * Points at the existing `/compact` command rather than auto-compacting.
 */
export function contextOverflowRecoveryNotice(message?: string): string {
    const detail =
        message !== undefined && message.trim().length > 0
            ? ` ${message.trim().replace(/^Error:\s*/u, '')}`
            : '';
    return `Context overflow.${detail} Run /compact to summarize older history, then retry.`;
}
