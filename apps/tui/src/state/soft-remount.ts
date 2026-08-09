/**
 * Soft remount / self-heal controller for the interactive TUI tree.
 *
 * A Solid render throw is caught by AppShell's ErrorBoundary. Rather than
 * forcing a process exit, the shell can request a tree remount while the
 * ChatStore (and CLI handle) stay alive. Snapshot reload is optional and
 * injected so the TUI never reaches into CLI session DB code.
 *
 * Concurrent requestRemount calls coalesce onto one in-flight generation so a
 * render-error loop cannot thrash generation counters / snapshot reloads.
 */

export type SoftRemountReason = 'render_error' | 'manual' | 'snapshot_heal';

export type SoftRemountRequest = {
    readonly generation: number;
    readonly reason: SoftRemountReason;
    readonly message: string | undefined;
    readonly at: number;
    /** False when thrash protection blocked a new generation bump. */
    readonly advanced: boolean;
};

export type SoftRemountControllerOptions = {
    /** Optional durable snapshot reload before the tree remounts. */
    readonly reloadSnapshot?: () => void | Promise<void>;
    /** Wall clock; injectable for tests. */
    readonly now?: () => number;
    /**
     * Minimum ms between distinct generation bumps after a remount settles.
     * Concurrent calls during an in-flight remount always coalesce.
     * Default 50.
     */
    readonly minIntervalMs?: number;
    /**
     * Cap distinct generation bumps inside a rolling window to stop a permanent
     * paint bug from thrashing forever. Default 5 bumps / 10s.
     */
    readonly maxConsecutive?: number;
    readonly consecutiveWindowMs?: number;
};

/**
 * Generation counter + optional snapshot reload for ErrorBoundary recovery.
 * Framework-free so unit tests never need Solid/OpenTUI.
 */
export class SoftRemountController {
    private generation = 0;
    private lastRequest: SoftRemountRequest | undefined;
    private readonly listeners = new Set<() => void>();
    private readonly reloadSnapshot: (() => void | Promise<void>) | undefined;
    private readonly now: () => number;
    private readonly minIntervalMs: number;
    private readonly maxConsecutive: number;
    private readonly consecutiveWindowMs: number;
    private recentRemountAts: number[] = [];
    private circuitOpenUntil = 0;
    private inflight: Promise<SoftRemountRequest> | undefined;
    private queued:
        | {
              readonly reason: SoftRemountReason;
              readonly message: string | undefined;
          }
        | undefined;
    private disposed = false;
    private followUpTimer: ReturnType<typeof setTimeout> | undefined;
    private releaseFollowUpDelay: (() => void) | undefined;

    constructor(options: SoftRemountControllerOptions = {}) {
        this.reloadSnapshot = options.reloadSnapshot;
        this.now = options.now ?? Date.now;
        this.minIntervalMs = options.minIntervalMs ?? 50;
        this.maxConsecutive = options.maxConsecutive ?? 5;
        this.consecutiveWindowMs = options.consecutiveWindowMs ?? 10_000;
    }

    getGeneration(): number {
        return this.generation;
    }

    getLastRequest(): SoftRemountRequest | undefined {
        return this.lastRequest;
    }

    /** True while a remount (and optional snapshot reload) is in flight. */
    isRemounting(): boolean {
        return this.inflight !== undefined;
    }

    /** True while thrash protection is blocking further generation bumps. */
    isCircuitOpen(): boolean {
        return this.now() < this.circuitOpenUntil;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Stops delayed follow-up remount work and releases listeners. A snapshot
     * reload already in progress is injected work and cannot be cancelled, but
     * it cannot publish or schedule another remount after disposal.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.queued = undefined;
        this.listeners.clear();
        if (this.followUpTimer !== undefined) {
            clearTimeout(this.followUpTimer);
            this.followUpTimer = undefined;
        }
        const release = this.releaseFollowUpDelay;
        this.releaseFollowUpDelay = undefined;
        release?.();
    }

    /**
     * Bump the mount generation (triggers App tree remount) and optionally
     * reload the session snapshot. Never throws to callers.
     *
     * Concurrent callers share one in-flight remount (no extra generation bump).
     * A request that arrives while in-flight is queued as a single follow-up
     * remount after the current one settles (still one extra generation max).
     */
    async requestRemount(reason: SoftRemountReason, message?: string): Promise<SoftRemountRequest> {
        if (this.disposed) return this.disposedRequest(reason, message);
        const now = this.now();
        if (now < this.circuitOpenUntil) {
            // Circuit open: return last request (or a synthetic no-op stamp) without bumping.
            if (this.lastRequest !== undefined) {
                return { ...this.lastRequest, advanced: false };
            }
            const request: SoftRemountRequest = {
                generation: this.generation,
                reason,
                message: message ?? 'soft-remount circuit open',
                at: now,
                advanced: false,
            };
            this.lastRequest = request;
            return request;
        }
        if (this.inflight !== undefined) {
            this.queued = { reason, message };
            return this.inflight;
        }

        const lastAt = this.lastRequest?.at;
        if (lastAt !== undefined && this.now() - lastAt < this.minIntervalMs) {
            // Rapid sequential thrash right after a settle: reuse last request
            // rather than spinning generations in a tight error loop.
            this.queued = { reason, message };
            // Schedule a single delayed follow-up if none is running.
            this.inflight = this.runFollowUpAfterInterval();
            return this.inflight;
        }

        this.inflight = this.executeRemount(reason, message).finally(() => {
            this.inflight = undefined;
            const next = this.takeQueued();
            if (!this.disposed && next !== undefined) {
                void this.requestRemount(next.reason, next.message);
            }
        });
        return this.inflight;
    }

    private async runFollowUpAfterInterval(): Promise<SoftRemountRequest> {
        const lastAt = this.lastRequest?.at ?? this.now();
        const waitMs = Math.max(0, this.minIntervalMs - (this.now() - lastAt));
        if (waitMs > 0) {
            await new Promise<void>((resolve) => {
                this.releaseFollowUpDelay = resolve;
                this.followUpTimer = setTimeout(() => {
                    this.followUpTimer = undefined;
                    this.releaseFollowUpDelay = undefined;
                    resolve();
                }, waitMs);
            });
        }
        if (this.disposed) {
            return this.disposedRequest(this.lastRequest?.reason ?? 'render_error', this.lastRequest?.message);
        }
        const next = this.takeQueued() ?? {
            reason: this.lastRequest?.reason ?? 'render_error',
            message: this.lastRequest?.message,
        };
        try {
            return await this.executeRemount(next.reason, next.message);
        } finally {
            this.inflight = undefined;
            const queued = this.takeQueued();
            if (!this.disposed && queued !== undefined) {
                void this.requestRemount(queued.reason, queued.message);
            }
        }
    }

    private takeQueued(): { readonly reason: SoftRemountReason; readonly message: string | undefined } | undefined {
        const queued = this.queued;
        this.queued = undefined;
        return queued;
    }

    private disposedRequest(reason: SoftRemountReason, message?: string): SoftRemountRequest {
        return {
            generation: this.generation,
            reason,
            message: message ?? 'soft-remount controller disposed',
            at: this.now(),
            advanced: false,
        };
    }

    private async executeRemount(reason: SoftRemountReason, message?: string): Promise<SoftRemountRequest> {
        const at = this.now();
        this.recentRemountAts = this.recentRemountAts.filter((ts) => at - ts <= this.consecutiveWindowMs);
        this.recentRemountAts.push(at);
        if (this.recentRemountAts.length > this.maxConsecutive) {
            this.circuitOpenUntil = at + this.consecutiveWindowMs;
            // Do not bump generation further; keep last tree stable for the window.
            const blocked: SoftRemountRequest = {
                generation: this.generation,
                reason,
                message: 'soft-remount circuit open — too many render recoveries; stabilize then retry',
                at,
                advanced: false,
            };
            this.lastRequest = blocked;
            this.publish(); // notify subscribers so the operator can see the circuit notice
            return blocked;
        }
        this.generation += 1;
        const request: SoftRemountRequest = {
            generation: this.generation,
            reason,
            message,
            at,
            advanced: true,
        };
        this.lastRequest = request;
        this.publish();

        if (this.reloadSnapshot !== undefined) {
            try {
                await this.reloadSnapshot();
            } catch {
                // Snapshot heal is best-effort; the remount still proceeds.
            }
        }

        return request;
    }

    private publish(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // Listener failures must not break remount.
            }
        }
    }
}

export function createSoftRemountController(options?: SoftRemountControllerOptions): SoftRemountController {
    return new SoftRemountController(options);
}
