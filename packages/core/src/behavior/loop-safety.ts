/**
 * Loop-safety detectors for ABG tool self-loops.
 *
 * Productive tool use is progress — we do NOT count tool volume. We trip when:
 * - the same tool turn repeats consecutively, or
 * - a short cycle of turns oscillates (A↔B, A→B→C→A, …), or
 * - the same failure combination repeats.
 */

export type ToolActionFingerprint = {
    readonly toolName: string;
    readonly inputDigest: string;
    readonly outcome: 'completed' | 'failed' | 'denied' | 'proposed';
    readonly errorCode?: string;
};

export type LoopSafetyLimits = {
    readonly identicalTurnStreak: number;
    readonly identicalFailureStreak: number;
    /** How many full periods of a short cycle must complete before soft-land (default 2 → A,B,A,B). */
    readonly cycleConfirmations: number;
    /** Max cycle period to detect (default 3 covers A↔B and A→B→C). */
    readonly maxCyclePeriod: number;
    readonly recentHistorySize: number;
};

export const DEFAULT_LOOP_SAFETY_LIMITS: LoopSafetyLimits = {
    identicalTurnStreak: 3,
    identicalFailureStreak: 3,
    cycleConfirmations: 2,
    maxCyclePeriod: 3,
    recentHistorySize: 12,
};

export type LoopSafetyTrip =
    | {
          readonly kind: 'soft_land';
          readonly code: 'repeated_tool_pattern' | 'oscillating_tool_pattern';
          readonly message: string;
          readonly streak: number;
          readonly signature: string;
      }
    | {
          readonly kind: 'fail';
          readonly code: 'repeated_failure_pattern' | 'oscillating_failure_pattern';
          readonly message: string;
          readonly streak: number;
          readonly signature: string;
      };

export type LoopSafetyNodeState = {
    lastTurnSignature: string | undefined;
    identicalTurnStreak: number;
    lastFailureSignature: string | undefined;
    identicalFailureStreak: number;
    /** Ring of recent turn signatures for short-cycle / oscillation detection. */
    recentTurnSignatures: string[];
    recentFailureSignatures: string[];
};

export function createLoopSafetyNodeState(): LoopSafetyNodeState {
    return {
        lastTurnSignature: undefined,
        identicalTurnStreak: 0,
        lastFailureSignature: undefined,
        identicalFailureStreak: 0,
        recentTurnSignatures: [],
        recentFailureSignatures: [],
    };
}

/** Stable digest for tool args — order-insensitive for plain objects. */
export function digestToolInput(input: unknown): string {
    if (input === undefined || input === null) {
        return '';
    }
    if (typeof input === 'string') {
        return input.length > 512 ? `${input.slice(0, 512)}…` : input;
    }
    try {
        return JSON.stringify(canonicalize(input));
    } catch {
        return String(input);
    }
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        out[key] = canonicalize(record[key]);
    }
    return out;
}

/**
 * Build a turn signature from the tool actions observed in one node run.
 * Empty turns (no tools) return undefined — not a loop signal.
 */
export function turnSignatureFromActions(actions: readonly ToolActionFingerprint[]): string | undefined {
    if (actions.length === 0) {
        return undefined;
    }
    // Prefer settled outcomes; fall back to proposed if settlement emits are missing.
    const settled = actions.filter((a) => a.outcome === 'completed' || a.outcome === 'failed' || a.outcome === 'denied');
    const source = settled.length > 0 ? settled : actions;
    const parts = source
        .map((a) => {
            const err = a.errorCode !== undefined ? `@${a.errorCode}` : '';
            return `${a.outcome}:${a.toolName}:${a.inputDigest}${err}`;
        })
        .sort();
    return parts.join('|');
}

export function failureSignatureFromActions(actions: readonly ToolActionFingerprint[]): string | undefined {
    const failures = actions.filter((a) => a.outcome === 'failed' || a.outcome === 'denied');
    if (failures.length === 0) {
        return undefined;
    }
    const parts = failures
        .map((a) => `${a.toolName}:${a.errorCode ?? 'failed'}:${a.inputDigest}`)
        .sort();
    return parts.join('|');
}

/**
 * Record a completed tool turn.
 * Soft-lands on: consecutive identical signatures, OR short oscillating cycles (A↔B, …).
 */
export function recordToolTurn(
    state: LoopSafetyNodeState,
    actions: readonly ToolActionFingerprint[],
    limits: LoopSafetyLimits = DEFAULT_LOOP_SAFETY_LIMITS,
): LoopSafetyTrip | undefined {
    const signature = turnSignatureFromActions(actions);
    if (signature === undefined) {
        state.lastTurnSignature = undefined;
        state.identicalTurnStreak = 0;
        return undefined;
    }
    if (state.lastTurnSignature === signature) {
        state.identicalTurnStreak += 1;
    } else {
        state.lastTurnSignature = signature;
        state.identicalTurnStreak = 1;
    }
    pushRecent(state.recentTurnSignatures, signature, limits.recentHistorySize);
    // Clear failure history on any settled tool activity that includes a completion.
    if (actions.some((a) => a.outcome === 'completed')) {
        state.lastFailureSignature = undefined;
        state.identicalFailureStreak = 0;
        state.recentFailureSignatures = [];
    }
    if (state.identicalTurnStreak >= limits.identicalTurnStreak) {
        return {
            kind: 'soft_land',
            code: 'repeated_tool_pattern',
            message: `identical tool turn repeated ${state.identicalTurnStreak} times`,
            streak: state.identicalTurnStreak,
            signature,
        };
    }
    const cycle = detectShortCycle(state.recentTurnSignatures, limits);
    if (cycle !== undefined) {
        return {
            kind: 'soft_land',
            code: 'oscillating_tool_pattern',
            message: `tool turn cycle of period ${cycle.period} repeated ${cycle.confirmations} times`,
            streak: cycle.period * cycle.confirmations,
            signature: cycle.signature,
        };
    }
    return undefined;
}

/**
 * Record a tool-failure-only turn. Identical consecutive failures or short failure cycles trip fail.
 */
export function recordFailureTurn(
    state: LoopSafetyNodeState,
    actions: readonly ToolActionFingerprint[],
    limits: LoopSafetyLimits = DEFAULT_LOOP_SAFETY_LIMITS,
    fallbackSignature?: string,
): LoopSafetyTrip | undefined {
    const signature = failureSignatureFromActions(actions) ?? fallbackSignature;
    if (signature === undefined) {
        return undefined;
    }
    if (state.lastFailureSignature === signature) {
        state.identicalFailureStreak += 1;
    } else {
        state.lastFailureSignature = signature;
        state.identicalFailureStreak = 1;
    }
    pushRecent(state.recentFailureSignatures, signature, limits.recentHistorySize);
    if (state.identicalFailureStreak >= limits.identicalFailureStreak) {
        return {
            kind: 'fail',
            code: 'repeated_failure_pattern',
            message: `identical failure combination repeated ${state.identicalFailureStreak} times`,
            streak: state.identicalFailureStreak,
            signature,
        };
    }
    const cycle = detectShortCycle(state.recentFailureSignatures, limits);
    if (cycle !== undefined) {
        return {
            kind: 'fail',
            code: 'oscillating_failure_pattern',
            message: `failure cycle of period ${cycle.period} repeated ${cycle.confirmations} times`,
            streak: cycle.period * cycle.confirmations,
            signature: cycle.signature,
        };
    }
    return undefined;
}

function pushRecent(history: string[], signature: string, maxSize: number): void {
    history.push(signature);
    if (history.length > maxSize) {
        history.splice(0, history.length - maxSize);
    }
}

/**
 * Detect a pure short cycle in the recent signature history.
 * Example period 2 with 2 confirmations: A,B,A,B (length 4).
 * Requires at least two distinct signatures (period >= 2) so AAA is handled by identical streak.
 */
export function detectShortCycle(
    history: readonly string[],
    limits: LoopSafetyLimits = DEFAULT_LOOP_SAFETY_LIMITS,
): { readonly period: number; readonly confirmations: number; readonly signature: string } | undefined {
    const maxPeriod = limits.maxCyclePeriod;
    const confirmations = limits.cycleConfirmations;
    for (let period = 2; period <= maxPeriod; period += 1) {
        const need = period * confirmations;
        if (history.length < need) {
            continue;
        }
        const window = history.slice(history.length - need);
        const pattern = window.slice(0, period);
        if (new Set(pattern).size < 2) {
            continue;
        }
        let pure = true;
        for (let i = 0; i < need; i += 1) {
            if (window[i] !== pattern[i % period]) {
                pure = false;
                break;
            }
        }
        if (pure) {
            return {
                period,
                confirmations,
                signature: `period${period}:${pattern.join('||')}`,
            };
        }
    }
    return undefined;
}

/** Extract tool fingerprints from an ABG emit payload (best-effort, never throws). */
export function toolActionFromEmit(eventType: string, payload: unknown): ToolActionFingerprint | undefined {
    if (typeof payload !== 'object' || payload === null) {
        return undefined;
    }
    const record = payload as Record<string, unknown>;
    const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : undefined;
    if (toolName === undefined || toolName.length === 0) {
        return undefined;
    }
    const inputRaw = record['input'] ?? record['argumentsJson'] ?? record['args'];
    const inputDigest = digestToolInput(inputRaw);
    if (eventType === 'llm.tool_call.proposed') {
        return { toolName, inputDigest, outcome: 'proposed' };
    }
    if (eventType === 'tool.completed') {
        return { toolName, inputDigest, outcome: 'completed' };
    }
    if (eventType === 'tool.failed') {
        const errorCode = readErrorCode(record['error']);
        return {
            toolName,
            inputDigest,
            outcome: 'failed',
            ...(errorCode !== undefined ? { errorCode } : {}),
        };
    }
    if (eventType === 'tool.denied') {
        return { toolName, inputDigest, outcome: 'denied', errorCode: 'denied' };
    }
    return undefined;
}

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const code = (error as Record<string, unknown>)['code'];
    return typeof code === 'string' && code.length > 0 ? code : undefined;
}
