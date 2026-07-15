/**
 * Capability filtering for the deprecated simple-task compatibility path.
 *
 * The full-parity runtime builds child authority with `buildChildToolSurface`: category rules plus
 * the nested-subagent deny, agent `pathPolicies`, hard capability drops, and invocation-time policy
 * enforcement. This module retains only the exact capability predicate used by the compatibility
 * factory; it does not derive permission rules from a parent session.
 */
import type { PermissionKind } from '@mission-control/protocol';

export const DESTRUCTIVE_PERMISSION_KINDS: readonly PermissionKind[] = ['bash', 'write', 'patch'];

/**
 * Capability kinds dropped from delegated child tool registries. Superset of the destructive
 * kinds: also drops `network` (webfetch/mcp/mcp__*), `subagent` (task), `workflow`, and `team`
 * (self-invokable workflow graph) capability classes. Without this superset, a parent
 * containing a network-capability tool would LEAK it into the child registry (the
 * `task`-by-name drop alone does not cover webfetch/mcp); `workflow` is dropped to prevent
 * a child from self-invoking a workflow graph and recursing back into the runtime adapter.
 *
 * Typed `string[]` (not `PermissionKind[]`) because these are capability CLASS identifiers
 * declared by tools — the set overlaps with but is broader than the CLI permission kinds
 * (e.g. `'workflow'` is a capability class but not a permission policy kind).
 */
export const CHILD_DROPPED_CAPABILITY_KINDS: readonly string[] = [
    ...DESTRUCTIVE_PERMISSION_KINDS,
    'edit',
    'network',
    'subagent',
    'workflow',
    'team',
];

/**
 * True if a tool capability set is safe to expose to a child. Defaults to dropping the full
 * `CHILD_DROPPED_CAPABILITY_KINDS` set (destructive + network + subagent + workflow + team); pass a
 * narrower `droppedKinds` to relax the check (e.g. tests that only want the destructive subset).
 */
export function isChildSafeCapability(
    capabilities: readonly string[],
    droppedKinds: readonly string[] = CHILD_DROPPED_CAPABILITY_KINDS,
): boolean {
    return !capabilities.some((capability) => droppedKinds.some((kind) => isExactDroppedCapability(capability, kind)));
}

function isExactDroppedCapability(capability: string, kind: string): boolean {
    if (capability === kind) return true;
    switch (kind) {
        case 'bash':
            return capability === 'bash.run' || capability === 'command.run';
        case 'edit':
            return capability === 'file.edit';
        case 'write':
            return capability === 'file.write';
        case 'patch':
            return capability === 'file.patch';
        default:
            return false;
    }
}
