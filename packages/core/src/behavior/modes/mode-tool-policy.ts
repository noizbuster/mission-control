/**
 * Tool-invocation-time enforcement of a workflow mode's policy-gate rules — layer 2 of
 * the two-layer mode contract (layer 1 is `modeGatePolicy`, the node gate).
 *
 * Scoped rules (`.mc/plans/**`, `.mc/specs/**`, ...) cannot be judged at the node gate
 * because no concrete resource is known there. This policy closes that gap: at every
 * tool invocation it resolves the resource(s) the arguments name (write/edit/patch
 * paths, command patterns — the same extraction the child `pathPolicies` gate uses)
 * and evaluates `evaluateRules(action, resource)` over the mode rules.
 *
 * Semantics (mirrors the existing child pathPolicies idiom in
 * `agents/child-tool-permissions.ts`): `deny` fails the tool with a clear policy error;
 * `allow` proceeds; `ask` neither blocks nor bypasses here — universal `ask` rules are
 * enforced at the node gate, and scoped `ask` defers to the workspace permission
 * store's own approval flow (the two systems stay separate; this policy only ADDS a
 * gate). For tools whose arguments carry no recognizable resource, a scoped `deny`
 * fails closed (the path cannot be proven allowed).
 */
import type { PolicyEffectRule, ProtocolError } from '@mission-control/protocol';
import { policyActionsFor } from '../../agents/child-tool-permissions';
import { childPolicyResourceValue, resourcesForChildInvocation } from '../../agents/child-tool-resources';
import { evaluateRules } from '../../permissions/rule-evaluator';
import { wildcardMatch } from '../../permissions/wildcard-match';
import type { ToolInvocationPolicy } from '../../tools/tool-registry';

/**
 * Build a `ToolRegistry` invocation policy enforcing the ACTIVE workflow modes'
 * policy rules at tool-invocation time. Apply it by wrapping the production registry:
 * `registry.cloneWithFilter(() => true, createModeToolInvocationPolicy(rules, root))`
 * (the clone preserves every registration and forwards the wrapped registry to child
 * surfaces, which inherit the mode gate).
 */
export function createModeToolInvocationPolicy(
    modePolicies: readonly PolicyEffectRule[],
    workspaceRoot: string,
): ToolInvocationPolicy {
    return (advertisement, parsedArguments) => {
        for (const action of policyActionsFor(advertisement)) {
            const resolution = resourcesForChildInvocation(advertisement.name, parsedArguments);
            if (resolution.kind === 'malformed') return undefined;
            if (resolution.kind === 'unsupported') {
                // No resource to match a scoped pattern against: fail closed when the
                // mode denies this action for some resource we cannot disprove.
                if (modePolicies.some((rule) => wildcardMatch(rule.action, action) && rule.effect === 'deny')) {
                    return modeDeniedError(advertisement.name, action);
                }
                continue;
            }
            const denied = resolution.resources.some(
                (resource) =>
                    evaluateRules(action, childPolicyResourceValue(resource, workspaceRoot), [
                        { rules: [...modePolicies] },
                    ]).effect === 'deny',
            );
            if (denied) {
                return modeDeniedError(advertisement.name, action);
            }
        }
        return undefined;
    };
}

function modeDeniedError(toolName: string, action: string): ProtocolError {
    return {
        code: 'tool_failed',
        message: `mode policy denied ${action} for ${toolName}`,
        retryable: false,
    };
}
