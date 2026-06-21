/**
 * ABG Blackboard — the structured runtime working-memory store (ABG §10.4, §5.7).
 *
 * Distinct from the JSONL event log: the event log is an append-only audit trail;
 * the Blackboard is the *mutable* scratch state a run reads and writes as it goes —
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
        this.onMutation?.('blackboard.set', { key, value });
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    delete(key: string): void {
        this.entries.delete(key);
        this.onMutation?.('blackboard.delete', { key });
    }

    /** Snapshot of entries as a plain object, for rule evaluation (`blackboard.*` predicates). */
    toRecord(): Readonly<Record<string, unknown>> {
        return Object.fromEntries(this.entries.entries());
    }

    listEntries(): readonly BlackboardEntry[] {
        return [...this.entries.entries()].map(([key, value]) => ({ key, value }));
    }
}

export function createBlackboard(options?: BlackboardOptions): Blackboard {
    return new Blackboard(options);
}
