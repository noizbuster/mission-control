/**
 * Subagent child permission policy (ABG §10.6, Phase 6).
 *
 * Derives a child agent's permission rules from the parent's allow-list, MINUS destructive
 * kinds (`bash`/`write`/`patch`) unless explicitly escalated — so a delegated subagent cannot
 * auto-approve destructive actions it inherited. Nested-`task` recursion is prevented at the
 * tool-registry layer (the child's registry simply does not register the `task` tool), which is
 * stronger than a permission rule and cannot be bypassed by a prompt.
 *
 * Capability blocklist (ABG §10.6 safety): `isChildSafeCapability` drops a STRICT superset of the
 * destructive kinds — it also drops `network` (webfetch/mcp) and `subagent` (task) capability
 * classes, so a delegated child registry built via `createChildToolRegistry` exposes NEITHER
 * network-reaching tools NOR further-subagent-spawning tools. Read-class capabilities stay
 * child-safe. Extending this set only ever drops MORE tools, so a previously-blocked tool can never
 * become admitted (no stale-state regression for persisted child-policy expectations).
 */
import type { PermissionKind, PermissionRule } from '@mission-control/protocol';

export const DESTRUCTIVE_PERMISSION_KINDS: readonly PermissionKind[] = ['bash', 'write', 'patch'];

/**
 * Capability kinds dropped from delegated child tool registries. Superset of the destructive
 * kinds: also drops `network` (webfetch/mcp/mcp__*) and `subagent` (task) capability classes.
 * Without this superset, a parent containing a network-capability tool would LEAK it into the
 * child registry (the `task`-by-name drop alone does not cover webfetch/mcp).
 */
export const CHILD_DROPPED_CAPABILITY_KINDS: readonly PermissionKind[] = [
    ...DESTRUCTIVE_PERMISSION_KINDS,
    'network',
    'subagent',
];

export type CreateChildPolicyInput = {
    readonly parentRules: readonly PermissionRule[];
    /** Destructive kinds the child must NOT inherit as allow/once. Defaults to bash/write/patch. */
    readonly escalateKinds?: readonly PermissionKind[];
};

/**
 * Returns the child's permission rules: the parent's allow/once rules with destructive kinds
 * removed (those fall through to the default `ask` path, surfacing for approval). Deny rules
 * are preserved.
 */
export function createChildPermissionRules(input: CreateChildPolicyInput): readonly PermissionRule[] {
    const escalate = input.escalateKinds ?? DESTRUCTIVE_PERMISSION_KINDS;
    const child: PermissionRule[] = [];
    for (const rule of input.parentRules) {
        if ((rule.decision === 'always' || rule.decision === 'once') && escalate.includes(rule.permission)) {
            continue;
        }
        child.push(rule);
    }
    return child;
}

/**
 * True if a tool capability set is safe to expose to a child. Defaults to dropping the full
 * `CHILD_DROPPED_CAPABILITY_KINDS` set (destructive + network + subagent); pass a narrower
 * `droppedKinds` to relax the check (e.g. tests that only want the destructive subset).
 */
export function isChildSafeCapability(
    capabilities: readonly string[],
    droppedKinds: readonly PermissionKind[] = CHILD_DROPPED_CAPABILITY_KINDS,
): boolean {
    return !capabilities.some((capability) => droppedKinds.some((kind) => capability.includes(kind)));
}
