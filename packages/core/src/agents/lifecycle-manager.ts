/**
 * AgentLifecycleManager - Owns the idle -> parked -> revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link adopt}; from then
 * on the manager arms a TTL timer whenever the agent goes `idle`, parks it on
 * expiry (disposes the live session via the supplied disposer, keeps the ref
 * + sessionFile), and revives it on demand through {@link ensureLive}. Only
 * this manager flips `parked` <-> `idle`.
 *
 * Adapted from oh-my-pi's `AgentLifecycleManager`. mission-control's
 * RuntimeAgentRegistry does not hold a live session object, so the disposer is
 * supplied as an adopt-time callback rather than read from the ref.
 */

import { type AgentRef, type AgentStatus, MAIN_AGENT_ID, type RuntimeAgentRegistry } from './runtime-registry.js';

/** Recreates an AgentRef from the ref's sessionFile after park. */
export type AgentReviver = (id: string) => Promise<AgentRef>;

/** Disposes an agent's live resources during park or release. */
export type AgentDisposer = (id: string) => Promise<void>;

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface LifecycleAdoptOptions {
    /** TTL before an idle agent is parked. <= 0 disables parking. Defaults to 420 000 (7 min). */
    readonly idleTtlMs?: number;
    /** Recreates a live ref from the sessionFile. Absent => not resumable after park. */
    readonly revive?: AgentReviver;
    /** Disposes live resources when the agent is parked or released. */
    readonly dispose?: AgentDisposer;
}

const DEFAULT_IDLE_TTL_MS = 420_000;

interface AdoptedAgent {
    idleTtlMs: number;
    revive: AgentReviver | undefined;
    dispose: AgentDisposer | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
}

export class AgentLifecycleManager {
    private readonly registry: RuntimeAgentRegistry;
    private readonly adopted: Map<string, AdoptedAgent> = new Map();
    /** Ids whose resources are being disposed by {@link park} right now. */
    private readonly parking: Set<string> = new Set();
    /** In-flight revives, so concurrent {@link ensureLive} calls coalesce. */
    private readonly revivals: Map<string, Promise<AgentRef>> = new Map();
    private persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
    /** TTL applied when a cold-revived ref is adopted on demand. */
    private persistedReviveTtlMs: number = 0;

    constructor(registry: RuntimeAgentRegistry) {
        this.registry = registry;
    }

    /**
     * Install the factory used to cold-revive `parked` refs restored from disk
     * — they carry a sessionFile but no in-memory adoption. Called by the
     * top-level session which owns the ambient deps the factory needs.
     */
    setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
        this.persistedReviverFactory = factory;
        this.persistedReviveTtlMs = idleTtlMs;
    }

    /**
     * Take ownership of a finished subagent. The caller has already registered
     * the ref and set status to "idle". Arms the TTL timer (idleTtlMs <= 0
     * adopts without one). `adopt(MAIN_AGENT_ID)` is a silent no-op.
     */
    adopt(id: string, opts: LifecycleAdoptOptions = {}): void {
        if (id === MAIN_AGENT_ID) return;
        if (this.registry.lookup(id) === undefined) return;

        const existing = this.adopted.get(id);
        if (existing?.timer !== undefined) clearTimeout(existing.timer);

        const adopted: AdoptedAgent = {
            idleTtlMs: opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
            revive: opts.revive,
            dispose: opts.dispose,
            timer: undefined,
        };
        this.adopted.set(id, adopted);
        this.armTimer(id, adopted);
    }

    /** True if the id is adopted (parked or live). */
    has(id: string): boolean {
        return this.adopted.has(id);
    }

    /** True while {@link park} is disposing this agent's resources. */
    isParking(id: string): boolean {
        return this.parking.has(id);
    }

    /**
     * Lifecycle-aware status transition for adopted agents. `running` disarms
     * the TTL timer; `idle` re-arms a fresh one. Use this instead of
     * `registry.update` for status changes on adopted agents so the timer
     * stays in sync. Non-adopted ids fall through to a plain registry update.
     */
    setStatus(id: string, status: AgentStatus): void {
        this.registry.update(id, { status });
        const adopted = this.adopted.get(id);
        if (adopted === undefined) return;
        if (status === 'running') {
            if (adopted.timer !== undefined) {
                clearTimeout(adopted.timer);
                adopted.timer = undefined;
            }
        } else if (status === 'idle') {
            this.armTimer(id, adopted);
        }
    }

    /**
     * Dispose the live resources, and mark the agent `parked`. No-op unless the
     * id is adopted and not already parked. The ref and sessionFile are
     * retained for later revival.
     */
    async park(id: string): Promise<void> {
        const adopted = this.adopted.get(id);
        if (adopted === undefined) return;
        const ref = this.registry.lookup(id);
        if (ref === undefined) return;
        if (ref.status === 'parked') return;

        if (adopted.timer !== undefined) {
            clearTimeout(adopted.timer);
            adopted.timer = undefined;
        }

        this.parking.add(id);
        try {
            if (adopted.dispose !== undefined) {
                try {
                    await adopted.dispose(id);
                } catch {
                    // Dispose failures are swallowed; the agent still parks.
                }
            }
            this.registry.update(id, { status: 'parked' });
        } finally {
            this.parking.delete(id);
        }
    }

    /**
     * Return a live ref, reviving from the sessionFile if parked. Throws a
     * plain Error if the id is unknown or parked without a reviver. Concurrent
     * calls share one in-flight revive.
     */
    async ensureLive(id: string): Promise<AgentRef> {
        const ref = this.registry.lookup(id);
        if (ref === undefined) {
            throw new Error(
                `Unknown agent "${id}" \u2014 it was never registered or has been released. If a transcript exists, read history://${id}.`,
            );
        }
        if (ref.status !== 'parked') return ref;

        const inflight = this.revivals.get(id);
        if (inflight !== undefined) return inflight;

        const revival = this.resolveAndRevive(id, ref);
        this.revivals.set(id, revival);
        try {
            return await revival;
        } finally {
            this.revivals.delete(id);
        }
    }

    /** Hard removal: dispose if live, unregister from registry, drop timers. */
    async release(id: string): Promise<void> {
        const adopted = this.adopted.get(id);
        if (adopted?.timer !== undefined) clearTimeout(adopted.timer);
        this.adopted.delete(id);

        const ref = this.registry.lookup(id);
        if (ref !== undefined && ref.status !== 'parked' && adopted?.dispose !== undefined) {
            try {
                await adopted.dispose(id);
            } catch {
                // Release dispose failures are non-fatal.
            }
        }
        this.registry.release(id);
    }

    /**
     * Resolve a reviver and bring the agent back to a live state. A ref
     * restored from disk is `parked` with a sessionFile but no in-memory
     * adoption; build a reviver via the injected persisted-subagent factory
     * and adopt it so the agent rejoins the normal idle<->parked lifecycle.
     */
    private async resolveAndRevive(id: string, ref: AgentRef): Promise<AgentRef> {
        let revive = this.adopted.get(id)?.revive;
        let coldAdopted = false;

        if (
            revive === undefined &&
            ref.status === 'parked' &&
            ref.sessionFile !== undefined &&
            this.persistedReviverFactory !== undefined
        ) {
            const factoryReviver = await this.persistedReviverFactory(ref);
            if (factoryReviver !== undefined) {
                revive = factoryReviver;
                this.adopted.set(id, {
                    idleTtlMs: this.persistedReviveTtlMs,
                    revive,
                    dispose: undefined,
                    timer: undefined,
                });
                coldAdopted = true;
            }
        }

        if (ref.status !== 'parked' || revive === undefined) {
            throw new Error(
                `Agent "${id}" is ${ref.status} and cannot be revived${revive !== undefined ? '' : ' (no reviver registered)'}. Its transcript remains readable at history://${id}.`,
            );
        }

        try {
            const revivedRef = await revive(id);
            this.registry.update(id, {
                status: 'idle',
                ...(revivedRef.sessionFile !== undefined ? { sessionFile: revivedRef.sessionFile } : {}),
            });
            const adopted = this.adopted.get(id);
            if (adopted !== undefined) this.armTimer(id, adopted);
            return revivedRef;
        } catch (error) {
            // A failed cold revive must not leave a poisoned reviver stuck in
            // adopted — drop it so a later ensureLive rebuilds via the factory.
            if (coldAdopted) this.adopted.delete(id);
            throw error;
        }
    }

    private armTimer(id: string, adopted: AdoptedAgent): void {
        if (adopted.idleTtlMs <= 0) return;
        if (adopted.timer !== undefined) clearTimeout(adopted.timer);
        adopted.timer = setTimeout(() => {
            adopted.timer = undefined;
            void this.park(id);
        }, adopted.idleTtlMs);
    }
}
