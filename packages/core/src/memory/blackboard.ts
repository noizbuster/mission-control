/**
 * ABG Blackboard — the structured runtime working-memory store (ABG §10.4, §5.7).
 *
 * Distinct from durable append-only session events in `mission-control.db`: the Blackboard
 * is the *mutable* scratch state a run reads and writes as it goes —
 * the running LLM message list, plus arbitrary key/value entries (goals, observations,
 * artifacts, hypotheses, pending questions) that `MemoryNode` and rule-gated re-entry
 * edges (`blackboard.key.exists` / `blackboard.value.equals`) read.
 *
 * Phase 1 scope: message accumulation (so the Observe→Decide→Act loop can re-enter
 * `LLMActor` with a growing conversation) + generic key/value (so the loop condition
 * is expressible as a rule-gated edge, and `MemoryNode` is real). Phase 2 enriches
 * this (semantic tiers, compaction, structured summary). The shape here is deliberately
 * the minimal contract the graph needs to *work end-to-end*.
 *
 * A single `Blackboard` instance is created per graph run (in `createCoordinatorState`)
 * and the SAME reference is handed to every node run via `AbgNodeRunContext`, so writes
 * persist across the loop without rebuilding from static input.
 */

import type { ModelMessage } from 'ai';

export type BlackboardEntry = {
    readonly key: string;
    readonly value: unknown;
};

export type BlackboardMutationKind = 'blackboard.set' | 'blackboard.delete';

export type BlackboardMutationPayload = {
    readonly key: string;
    readonly value?: unknown;
};

export type BlackboardMutationObserver = (kind: BlackboardMutationKind, payload: BlackboardMutationPayload) => void;

export type BlackboardOptions = {
    readonly onMutation?: BlackboardMutationObserver;
};

export class Blackboard {
    private readonly entries = new Map<string, unknown>();
    private messages: readonly ModelMessage[] = [];
    private readonly onMutation: BlackboardMutationObserver | undefined;
    // Cached `toRecord()` snapshot. Invalidated DIRECTLY in set/delete — NOT via the
    // optional external onMutation observer (it is undefined when no coordinator wires
    // it; Oracle M1). Frozen so a consumer cannot corrupt the shared cache reference.
    private cachedRecord: Readonly<Record<string, unknown>> | undefined;

    constructor(options: BlackboardOptions = {}) {
        this.onMutation = options.onMutation;
    }

    /**
     * The running conversation. `LLMActor` reads this as its input message list and
     * appends its assistant turn + tool results after each step so the next re-entry
     * sees the full history (the SDK's own multi-step loop is disabled via
     * `stopWhen: stepCountIs(1)` — the graph owns the loop, the Blackboard holds it).
     */
    getMessages(): readonly ModelMessage[] {
        return this.messages;
    }

    setMessages(messages: readonly ModelMessage[]): void {
        this.messages = [...messages];
    }

    appendMessages(messages: readonly ModelMessage[]): void {
        this.messages = [...this.messages, ...messages];
    }

    /** Generic key/value scratch — read by `MemoryNode` and rule-gated re-entry edges. */
    get(key: string): unknown {
        return this.entries.get(key);
    }

    set(key: string, value: unknown): void {
        this.entries.set(key, value);
        this.cachedRecord = undefined;
        this.onMutation?.('blackboard.set', { key, value });
    }

    /**
     * Replace key/value entries from a trusted snapshot without emitting mutation events.
     * Running messages are left unchanged.
     */
    seedEntries(entries: Readonly<Record<string, unknown>>): void {
        this.entries.clear();
        for (const [key, value] of Object.entries(entries)) {
            this.entries.set(key, value);
        }
        this.cachedRecord = undefined;
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    delete(key: string): void {
        this.entries.delete(key);
        this.cachedRecord = undefined;
        this.onMutation?.('blackboard.delete', { key });
    }

    /** Snapshot of entries as a plain object, for rule evaluation (`blackboard.*` predicates). */
    toRecord(): Readonly<Record<string, unknown>> {
        if (this.cachedRecord !== undefined) {
            return this.cachedRecord;
        }
        const record = Object.freeze(Object.fromEntries(this.entries.entries()));
        this.cachedRecord = record;
        return record;
    }

    listEntries(): readonly BlackboardEntry[] {
        return [...this.entries.entries()].map(([key, value]) => ({ key, value }));
    }
}

export function createBlackboard(options?: BlackboardOptions): Blackboard {
    return new Blackboard(options);
}
