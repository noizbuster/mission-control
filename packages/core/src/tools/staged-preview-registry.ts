// allow: SIZE_OK — single cohesive concept (session-scoped pending-invoker slot).
/**
 * Session-scoped registry of pending preview actions (Wave 4, task 12).
 *
 * Mirrors oh-my-pi's `peekPendingInvoker` pattern (MIT, adapted with
 * attribution) in plain TypeScript: a tool that produces a previewed-but-
 * uncommitted action (e.g. `ast_edit`) registers a {@link StagedPreviewAction}
 * here; the `resolve` tool peeks + dispatches it. `resolve` is the ONLY commit
 * path for a previewed edit.
 *
 * The registry holds at most ONE pending entry. A new registration replaces
 * an unconsumed one (last-wins, matching oh-my-pi's queue-head semantics: a
 * fresh preview supersedes a stale one the model never resolved).
 *
 * Session-scoped: one instance per session, shared between the proposing tool
 * and `resolve` via their respective tool options. It is NOT a global
 * singleton, so concurrent sessions never cross their staged previews.
 */

/** One file's worth of pending replacements, surfaced for reporting. */
export type StagedPreviewChange = {
    /** Workspace-relative path of a file with pending replacements. */
    readonly path: string;
    /** Number of replacements proposed for this file. */
    readonly count: number;
};

/** Human-readable summary of a staged preview, carried into `resolve` output. */
export type StagedPreviewSummary = {
    readonly label: string;
    readonly sourceToolName: string;
    readonly proposedCount: number;
    readonly files: readonly StagedPreviewChange[];
};

/**
 * A previewed action awaiting `resolve`.
 *
 * - `apply` commits the change. It MUST re-validate against current disk state
 *   and throw on staleness or write failure; it is the only path that writes.
 * - `discard` is optional cleanup (e.g. releasing resources). It never writes.
 *
 * Both closures receive the `reason` the model supplied to `resolve`; `apply`
 * also receives that resolve invocation's tool-call id for approval correlation.
 */
export type StagedPreviewAction = {
    readonly id: string;
    readonly summary: StagedPreviewSummary;
    readonly apply: (reason: string, resolveToolCallId: string) => Promise<readonly StagedPreviewChange[]>;
    readonly discard?: (reason: string) => Promise<void>;
};

/**
 * Holds the single pending preview action for a session.
 *
 * `register` overwrites; `consume` atomically removes and returns; `peek`
 * observes without removing. All methods are synchronous — the async work
 * lives inside the action's `apply`/`discard` closures.
 */
export class StagedPreviewRegistry {
    private pending: StagedPreviewAction | undefined;

    /** Register a new pending action, replacing an unconsumed one. */
    register(action: StagedPreviewAction): void {
        this.pending = action;
    }

    /** Peek the current pending action without consuming it. */
    peek(): StagedPreviewAction | undefined {
        return this.pending;
    }

    /** Consume and return the pending action (clears the slot). Returns
     * `undefined` when nothing is pending. */
    consume(): StagedPreviewAction | undefined {
        const action = this.pending;
        this.pending = undefined;
        return action;
    }

    /** Clear the pending slot without invoking the action. */
    clear(): void {
        this.pending = undefined;
    }

    get hasPending(): boolean {
        return this.pending !== undefined;
    }
}
