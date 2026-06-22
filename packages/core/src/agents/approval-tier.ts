/**
 * Tier-based approval gate (oh-my-pi pattern).
 *
 * Each tool declares a capability {@link ToolTier}: `read`, `write`, or `exec`.
 * The active {@link ApprovalMode} determines how many tiers are auto-approved
 * before the user must be asked:
 *
 * - `always-ask` — approves nothing; every tool call prompts the user.
 * - `write` — auto-approves `read` and `write`; `exec` still prompts.
 * - `yolo` — auto-approves everything (subject to user per-tool overrides).
 *
 * Per-tool user policies (`userPolicies[toolName]`) take precedence over the
 * mode: `prompt` and `deny` force an approval prompt regardless of mode,
 * while `allow` defers to the standard mode tier comparison.
 *
 * Child task sessions are FORCED to `yolo` mode by `ConcreteTaskToolRuntime`
 * (todo 22) — the parent's `task()` approval IS the authorization boundary.
 * This module does not enforce that; it only provides the resolution logic.
 *
 * This is a separate dimension from the workflow `PolicyEffectRule`
 * (action/resource/effect) and the workspace `PermissionRule`
 * (permission/pattern/decision). Do not collapse them.
 */

export type ToolTier = 'read' | 'write' | 'exec';

export type ApprovalMode = 'always-ask' | 'write' | 'yolo';

export type UserToolPolicy = 'allow' | 'deny' | 'prompt';

export const TIER_RANK: Readonly<Record<ToolTier, number>> = {
    read: 0,
    write: 1,
    exec: 2,
};

/**
 * The highest tier each mode is *nominally* willing to auto-approve.
 *
 * `always-ask` is mapped to `read` for parity with the oh-my-pi constant, but
 * the resolution logic treats it as "approves nothing" — see {@link modeAutoApproveRank}.
 */
export const APPROVAL_MODE_MAX_TIER: Readonly<Record<ApprovalMode, ToolTier>> = {
    'always-ask': 'read',
    write: 'write',
    yolo: 'exec',
};

export interface ResolveApprovalInput {
    readonly toolTier: ToolTier;
    readonly mode: ApprovalMode;
    readonly userPolicies?: Record<string, UserToolPolicy>;
    readonly toolName?: string;
}

export interface ApprovalResolution {
    readonly requiresApproval: boolean;
    readonly reason: string;
}

/**
 * Numeric rank for a tier. Uses dot-notation access on {@link TIER_RANK} to
 * stay clean under `noUncheckedIndexedAccess`.
 */
function rankForTier(tier: ToolTier): number {
    switch (tier) {
        case 'read':
            return TIER_RANK.read;
        case 'write':
            return TIER_RANK.write;
        case 'exec':
            return TIER_RANK.exec;
    }
}

/**
 * Highest tier rank auto-approved by the mode.
 *
 * `always-ask` returns -1 (below `read`) so that even read-tier tools prompt.
 * `write` and `yolo` derive their threshold from {@link APPROVAL_MODE_MAX_TIER}
 * via {@link rankForTier}.
 */
function modeAutoApproveRank(mode: ApprovalMode): number {
    switch (mode) {
        case 'always-ask':
            return -1;
        case 'write':
            return rankForTier(APPROVAL_MODE_MAX_TIER.write);
        case 'yolo':
            return rankForTier(APPROVAL_MODE_MAX_TIER.yolo);
    }
}

/**
 * Resolve whether a tool call requires user approval.
 *
 * Resolution order:
 *  1. **User per-tool policy** — if `userPolicies[toolName]` is set:
 *     - `prompt` or `deny` → requires approval (overrides mode).
 *     - `allow` → skip to the mode tier check.
 *  2. **Mode tier comparison** — the tool requires approval when its tier
 *     rank exceeds the mode's auto-approval threshold.
 */
export function resolveApproval(input: ResolveApprovalInput): ApprovalResolution {
    const { toolTier, mode, userPolicies, toolName } = input;

    if (toolName !== undefined && userPolicies?.[toolName] !== undefined) {
        const policy = userPolicies[toolName];
        if (policy === 'prompt' || policy === 'deny') {
            return {
                requiresApproval: true,
                reason: `user policy '${policy}' for tool '${toolName}'`,
            };
        }
        // 'allow' — fall through to mode tier comparison.
    }

    if (rankForTier(toolTier) > modeAutoApproveRank(mode)) {
        return {
            requiresApproval: true,
            reason: `tier '${toolTier}' exceeds '${mode}' mode threshold`,
        };
    }

    return {
        requiresApproval: false,
        reason: `tier '${toolTier}' within '${mode}' mode threshold`,
    };
}
