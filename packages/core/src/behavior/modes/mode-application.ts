/**
 * Mode application logic (Task 3.8).
 *
 * `applyMode` is a pure function that overlays a {@link Mode} onto an {@link AbgGraphSpec},
 * producing a NEW graph (the input is never mutated). Three structural transforms:
 *
 *   1. **System-prompt overlay** — when `mode.systemPromptOverlay` is present, it is PREPENDED
 *      to the `config.systemPrompt` of every `llm`-kind node. The existing prompt (if any) is
 *      preserved below the overlay so node-specific instructions still apply.
 *
 *   2. **Policy-gate rules** — `mode.policies` (`PolicyEffectRule[]`: action/resource/effect)
 *      are converted to `AbgPolicySpec` entries (id/capability/decision) and appended to
 *      `graph.policies`. The two vocabularies are intentionally distinct (AGENTS.md: "they
 *      coexist by design"); the conversion preserves the action as capability, the effect as
 *      decision, and the resource glob as the policy `reason`.
 *
 *   3. **Required-tools filter** — when `mode.requiredTools` is non-empty, each node's
 *      `capabilities` array is intersected with the required set, restricting the tool surface.
 *
 * The graph schema is NOT modified. The conversion in step 2 keeps `AbgGraphSpecSchema` valid
 * without touching protocol definitions.
 */
import type {
    AbgGraphSpec,
    AbgNodeSpec,
    AbgPolicyDecision,
    AbgPolicySpec,
    Mode,
    PolicyEffect,
} from '@mission-control/protocol';

/**
 * Map a workflow policy-gate {@link PolicyEffect} to an ABG graph {@link AbgPolicyDecision}.
 *
 * `'ask'` has no direct equivalent in the approval-decision vocabulary — it maps to
 * `'requires_approval'` (the conservative "defer to human" decision).
 */
function effectToDecision(effect: PolicyEffect): AbgPolicyDecision {
    switch (effect) {
        case 'allow':
            return 'allow';
        case 'deny':
            return 'deny';
        case 'ask':
            return 'requires_approval';
    }
}

/**
 * Convert a mode {@link PolicyEffectRule} (action/resource/effect) into a graph
 * {@link AbgPolicySpec} (id/capability/decision/reason).
 *
 * The `resource` glob is preserved in the `reason` field so the resource scope is not lost.
 * The `id` is namespaced by mode id + index to avoid collisions with existing graph policies.
 */
function convertModePolicy(modeId: string, index: number, rule: Mode['policies'][number]): AbgPolicySpec {
    return {
        id: `${modeId}:policy:${index}`,
        capability: rule.action,
        decision: effectToDecision(rule.effect),
        reason: `resource:${rule.resource}`,
    };
}

/**
 * Prepend the overlay to a node's `config.systemPrompt`, returning a NEW node.
 *
 * Only `llm`-kind nodes receive the overlay (these are the llm-actor nodes). The existing
 * prompt is preserved below the overlay with a blank-line separator. If the node has no
 * existing prompt, the overlay becomes the full prompt.
 */
function applyOverlayToNode(node: AbgNodeSpec, overlay: string): AbgNodeSpec {
    const key = 'systemPrompt';
    const existingPrompt = node.config?.[key];
    const existingString = typeof existingPrompt === 'string' && existingPrompt.length > 0 ? existingPrompt : '';
    const mergedPrompt = existingString.length > 0 ? `${overlay}\n\n${existingString}` : overlay;
    return {
        ...node,
        config: { ...node.config, [key]: mergedPrompt },
    };
}

/**
 * Intersect a node's `capabilities` with the required-tools set, returning a NEW node.
 *
 * A node without `capabilities` is returned unchanged (it has no tool surface to filter).
 * A node whose capabilities fall outside the required set gets an empty array — the node
 * retains its identity but loses tool access, which is the intended restriction.
 */
function applyRequiredToolsFilter(node: AbgNodeSpec, requiredTools: readonly string[]): AbgNodeSpec {
    if (node.capabilities === undefined) {
        return node;
    }
    const requiredSet = new Set(requiredTools);
    const filtered = node.capabilities.filter((capability) => requiredSet.has(capability));
    return { ...node, capabilities: filtered };
}

/**
 * Apply a {@link Mode} to an {@link AbgGraphSpec}, returning a new graph.
 *
 * Pure: the input `graph` and its nested arrays/objects are never mutated. Every modified
 * branch is shallow-copied via spread, and nodes are mapped to fresh objects.
 */
export function applyMode(graph: AbgGraphSpec, mode: Mode): AbgGraphSpec {
    // Step 1: system-prompt overlay on llm-actor nodes.
    // Capture optional values in consts so flow-narrowing survives the .map closure.
    const overlay = mode.systemPromptOverlay;
    const baseNodes =
        overlay !== undefined
            ? graph.nodes.map((node) => (node.kind === 'llm' ? applyOverlayToNode(node, overlay) : node))
            : graph.nodes;

    // Step 2: required-tools capability filter.
    const requiredTools = mode.requiredTools;
    const nodes =
        requiredTools !== undefined && requiredTools.length > 0
            ? baseNodes.map((node) => applyRequiredToolsFilter(node, requiredTools))
            : baseNodes;

    // Step 3: convert + append mode policies.
    const convertedPolicies = mode.policies.map((rule, index) => convertModePolicy(mode.id, index, rule));
    const policies = [...graph.policies, ...convertedPolicies];

    return {
        ...graph,
        nodes,
        policies,
    };
}
