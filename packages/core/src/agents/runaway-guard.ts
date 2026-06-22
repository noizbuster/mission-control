/**
 * Runaway-request guard for child agent sessions (oh-my-pi pattern).
 *
 * Each child agent session counts assistant `message_end` events as one
 * "request". When the count crosses a per-category soft budget the guard
 * signals a single steering notice telling the child to wrap up; if the
 * count reaches 1.5x the soft budget the guard signals a graceful abort so
 * the parent can salvage whatever output the child produced.
 *
 * The guard is purely counter-based: no timers, no async sleeps. The caller
 * (task tool runtime) is responsible for calling `trackRequest()` on each
 * assistant turn, calling `checkBudget()` after each request, and using
 * `formatSalvageSnippet()` to build the cancelled-child summary line.
 *
 * Mirrors `SOFT_REQUEST_BUDGET` and the budget branch of the
 * `message_end` handler in oh-my-pi's `executor.ts`.
 */

export const DEFAULT_SOFT_REQUEST_BUDGET = 90;

/**
 * Per-agent-name soft request budget. A child crossing this many assistant
 * requests gets a single steering notice; at 1.5x the run is aborted.
 *
 * The `default` entry applies to any agent name without an explicit entry
 * and can be overridden by passing an explicit `softBudget` to the guard.
 */
export const SOFT_REQUEST_BUDGET: Readonly<Record<string, number>> = {
    explore: 40,
    quick: 40,
    default: DEFAULT_SOFT_REQUEST_BUDGET,
};

export type BudgetAction = 'continue' | 'steer' | 'abort';

export interface BudgetCheck {
    readonly action: BudgetAction;
    readonly reason?: string;
}

/**
 * Tracks assistant requests for one child agent session and decides when to
 * steer (soft budget crossed) or abort (1.5x soft budget crossed).
 *
 * The steering signal fires at most once per guard instance so the caller
 * never re-injects the wrap-up notice on every subsequent request.
 */
export class RunawayGuard {
    private requests = 0;
    private steerSent = false;
    private readonly resolvedBudget: number;

    constructor(agentName: string, softBudget?: number) {
        const named = SOFT_REQUEST_BUDGET[agentName];
        this.resolvedBudget = softBudget ?? named ?? DEFAULT_SOFT_REQUEST_BUDGET;
    }

    /** Record one assistant `message_end` event. */
    trackRequest(): void {
        this.requests += 1;
    }

    /**
     * Decide what to do after a request was tracked.
     *
     * - `abort` takes priority and carries `reason: 'request budget exceeded'`
     *   so the caller can surface it as `{ aborted: true, exitCode: 1,
     *   abortReason }`.
     * - `steer` fires at most once (the `steerSent` flag suppresses repeats).
     * - `continue` otherwise.
     */
    checkBudget(): BudgetCheck {
        if (this.requests >= this.resolvedBudget * 1.5) {
            return { action: 'abort', reason: 'request budget exceeded' };
        }
        if (this.requests >= this.resolvedBudget && !this.steerSent) {
            this.steerSent = true;
            return { action: 'steer' };
        }
        return { action: 'continue' };
    }

    get requestCount(): number {
        return this.requests;
    }

    get softBudget(): number {
        return this.resolvedBudget;
    }

    get hasSentSteer(): boolean {
        return this.steerSent;
    }
}

/** Maximum length of the salvage snippet (before the ellipsis marker). */
const SALVAGE_SNIPPET_MAX = 700;

/**
 * Build the cancelled-child summary line.
 *
 * Whitespace in `lastAssistantText` is flattened to single spaces so the
 * summary stays on one line. When the flattened text exceeds
 * {@linkcode SALVAGE_SNIPPET_MAX} characters it is clipped and an ellipsis
 * marker is appended. When there is no salvage text the line falls back to
 * the `(no output)` form, which still records the request count.
 *
 * Examples:
 *   formatSalvageSnippet(3, undefined, 120)
 *     -> "[cancelled after 3 req, (no output)]"
 *   formatSalvageSnippet(1, "done", 50)
 *     -> "[cancelled after 1 req, 50 tok … last activity: done]"
 */
export function formatSalvageSnippet(requestCount: number, lastAssistantText?: string, tokenCount?: number): string {
    const flattened = (lastAssistantText ?? '').replace(/\s+/g, ' ').trim();
    if (flattened.length === 0) {
        return `[cancelled after ${requestCount} req, (no output)]`;
    }
    const snippet =
        flattened.length > SALVAGE_SNIPPET_MAX ? `${flattened.slice(0, SALVAGE_SNIPPET_MAX - 3)}…` : flattened;
    const tokens = tokenCount ?? '?';
    return `[cancelled after ${requestCount} req, ${tokens} tok … last activity: ${snippet}]`;
}
