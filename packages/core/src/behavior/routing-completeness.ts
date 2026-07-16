/**
 * Routing completeness classifier (ABG progress contract, todo 3).
 *
 * After a node completes successfully, the coordinator must distinguish:
 * - **progressed** — a select target or at least one outbound edge enqueues work
 * - **intentional_terminal** — zero authored outbound edges, or `config.terminal: true`
 * - **dead_end** — outbound edges exist but are conditional-only and none match
 *   (and no valid select target)
 *
 * Intentional sinks (present / complete / blocked-escalation with zero outbound)
 * MUST NOT be classified as dead_end. Conditional-only miss after success MUST
 * NOT be treated as graph completion (todo 5 wires fail/re-admit).
 *
 * Pure: no I/O, no coordinator mutation. Todo 5 calls this after
 * `enqueueSelectedTargets` (or as the empty-queue decision input).
 */

export const ROUTING_PROGRESS_CLASSES = ['progressed', 'intentional_terminal', 'dead_end'] as const;
export type RoutingProgressClass = (typeof ROUTING_PROGRESS_CLASSES)[number];

/** Minimal edge shape needed for classification (mirrors AbgEdgeSpec fields used). */
export type RoutingOutboundEdge = {
    readonly target: string;
    readonly condition?: string;
};

export type ClassifyRoutingProgressInput = {
    /**
     * Node config bag. When `terminal === true`, the node is an intentional sink
     * even if outbound edges are authored (explicit terminal marker).
     */
    readonly nodeConfig?: Readonly<Record<string, unknown>>;
    /** Authored edges whose `source` is the completed node. */
    readonly outboundEdges: readonly RoutingOutboundEdge[];
    /**
     * Returns true when the named edge condition rule matches the live evaluation
     * input (blackboard / signal / event / policy). Unconditional edges never call this.
     */
    readonly ruleMatches: (ruleId: string) => boolean;
    /**
     * When the completed node emitted a `select` signal, its target id.
     * Combined with `selectTargetExists` to count as progress.
     */
    readonly selectTarget?: string;
    /** Whether `selectTarget` resolves to a node in the graph. */
    readonly selectTargetExists?: boolean;
};

/**
 * Classify post-success routing progress for one completed node.
 *
 * Decision order (normative):
 * 1. Valid select target → `progressed`
 * 2. `config.terminal === true` → `intentional_terminal`
 * 3. Zero authored outbound edges → `intentional_terminal`
 * 4. Any unconditional edge, or any conditional edge whose rule matches → `progressed`
 * 5. Otherwise (conditional-only, zero matches, no valid select) → `dead_end`
 */
export function classifyRoutingProgress(input: ClassifyRoutingProgressInput): RoutingProgressClass {
    if (input.selectTarget !== undefined && input.selectTargetExists === true) {
        return 'progressed';
    }

    if (input.nodeConfig?.['terminal'] === true) {
        return 'intentional_terminal';
    }

    if (input.outboundEdges.length === 0) {
        return 'intentional_terminal';
    }

    for (const edge of input.outboundEdges) {
        if (edge.condition === undefined) {
            return 'progressed';
        }
        if (input.ruleMatches(edge.condition)) {
            return 'progressed';
        }
    }

    return 'dead_end';
}

/**
 * True when classification is a silent-complete hazard under the current
 * coordinator (empty queue after success → `graph.completed`). Todo 5 must
 * treat this as re-admit / failGraph, never completed.
 */
export function isRoutingDeadEnd(classification: RoutingProgressClass): boolean {
    return classification === 'dead_end';
}
