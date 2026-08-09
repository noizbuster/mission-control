/**
 * Stream silence watchdog (omo poll-for-completion / event-watchdog aligned).
 *
 * While `generating` is true the UI tracks the last transcript/status activity
 * timestamp. After `STREAM_SILENCE_WARN_MS` with no activity the dock spinner
 * surfaces a calm "still waiting" cue so a hung provider is visible without
 * aborting the turn (kick/interrupt remain operator-driven).
 */

/** Silence window before the UI warns that no stream events arrived. */
export const STREAM_SILENCE_WARN_MS = 30_000;

export type StreamSilenceStatus = {
    /** Whole seconds of silence (ceil); undefined when not warning. */
    readonly silentSeconds: number | undefined;
    /** Spinner/status suffix, e.g. `No events for 35s`. */
    readonly label: string | undefined;
};

/**
 * Pure view of stream silence for the agent status line.
 * Returns no warning unless generating and the silence window is exceeded.
 */
export function streamSilenceStatus(input: {
    readonly generating: boolean;
    readonly lastActivityAt: number | undefined;
    readonly now: number;
    readonly warnAfterMs?: number;
}): StreamSilenceStatus {
    if (!input.generating || input.lastActivityAt === undefined) {
        return { silentSeconds: undefined, label: undefined };
    }
    const warnAfterMs = input.warnAfterMs ?? STREAM_SILENCE_WARN_MS;
    const silentMs = input.now - input.lastActivityAt;
    if (!(silentMs >= warnAfterMs) || !Number.isFinite(silentMs)) {
        return { silentSeconds: undefined, label: undefined };
    }
    const silentSeconds = Math.max(1, Math.ceil(silentMs / 1000));
    return {
        silentSeconds,
        label: `No events for ${silentSeconds}s`,
    };
}

/** Merge base agent status text with an optional silence suffix. */
export function formatAgentStatusWithSilence(baseText: string, silenceLabel: string | undefined): string {
    if (silenceLabel === undefined || silenceLabel.length === 0) {
        return baseText;
    }
    if (baseText.length === 0) {
        return `${silenceLabel} — still waiting…`;
    }
    return `${baseText} · ${silenceLabel}`;
}
