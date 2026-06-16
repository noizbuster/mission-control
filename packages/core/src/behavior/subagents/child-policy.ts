/**
 * Subagent child permission policy (ABG §10.6, Phase 6).
 *
 * Derives a child agent's permission rules from the parent's allow-list, MINUS destructive
 * kinds (`bash`/`write`/`patch`) unless explicitly escalated — so a delegated subagent cannot
 * auto-approve destructive actions it inherited. Nested-`task` recursion is prevented at the
 * tool-registry layer (the child's registry simply does not register the `task` tool), which is
 * stronger than a permission rule and cannot be bypassed by a prompt.
 */
import type { PermissionKind, PermissionRule } from '@mission-control/protocol';

export const DESTRUCTIVE_PERMISSION_KINDS: readonly PermissionKind[] = ['bash', 'write', 'patch'];

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

/** True if a tool capability set is safe to expose to a child (no destructive kind). */
export function isChildSafeCapability(
    capabilities: readonly string[],
    escalateKinds: readonly PermissionKind[] = DESTRUCTIVE_PERMISSION_KINDS,
): boolean {
    return !capabilities.some((capability) => escalateKinds.some((kind) => capability.includes(kind)));
}
