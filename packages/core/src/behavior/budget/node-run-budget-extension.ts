/**
 * Agent-granted node-run budget extension.
 *
 * When a graph hits `maxNodeRuns`, the coordinator may ask a parent/supervisor
 * agent (not a human) for more runs. Grants are chunked and hard-capped so a
 * runaway loop cannot extend forever even if the agent keeps approving.
 */

export const DEFAULT_NODE_RUN_BUDGET_GRANT = 40;
export const DEFAULT_MAX_NODE_RUN_BUDGET_EXTENSIONS = 2;

export type NodeRunBudgetExtensionRequest = {
    readonly graphId: string;
    readonly sessionId: string;
    readonly used: number;
    readonly limit: number;
    readonly proposedGrant: number;
    readonly extensionsUsed: number;
    readonly maxExtensions: number;
    readonly hardCeiling: number;
    readonly recentNodeIds: readonly string[];
};

export type NodeRunBudgetExtensionDecision = {
    readonly granted: boolean;
    readonly grant?: number;
    readonly reason?: string;
};

export type NodeRunBudgetExtensionRequester = (
    request: NodeRunBudgetExtensionRequest,
) => Promise<NodeRunBudgetExtensionDecision>;

export type ApplyNodeRunBudgetGrantInput = {
    readonly currentMax: number;
    readonly hardCeiling: number;
    readonly proposedGrant: number;
    readonly decision: NodeRunBudgetExtensionDecision;
};

export type ApplyNodeRunBudgetGrantResult =
    | { readonly applied: false; readonly reason: string }
    | { readonly applied: true; readonly grant: number; readonly nextMax: number };

export function hardCeilingForNodeRunBudget(input: {
    readonly initialMax: number;
    readonly grantSize: number;
    readonly maxExtensions: number;
}): number {
    return input.initialMax + input.grantSize * input.maxExtensions;
}

export function applyNodeRunBudgetGrant(input: ApplyNodeRunBudgetGrantInput): ApplyNodeRunBudgetGrantResult {
    if (!input.decision.granted) {
        return {
            applied: false,
            reason: input.decision.reason ?? 'agent denied node-run budget extension',
        };
    }
    const requested = input.decision.grant ?? input.proposedGrant;
    if (!Number.isFinite(requested) || requested <= 0) {
        return { applied: false, reason: 'agent grant was non-positive' };
    }
    const room = input.hardCeiling - input.currentMax;
    if (room <= 0) {
        return { applied: false, reason: 'hard ceiling already reached' };
    }
    const grant = Math.min(Math.floor(requested), room);
    if (grant <= 0) {
        return { applied: false, reason: 'no room under hard ceiling' };
    }
    return { applied: true, grant, nextMax: input.currentMax + grant };
}

export function parseAgentBudgetDecisionText(
    text: string,
    proposedGrant: number,
): NodeRunBudgetExtensionDecision {
    const line = text
        .trim()
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
    if (line === undefined) {
        return { granted: false, reason: 'empty agent response' };
    }
    const approve = /^APPROVE(?:\s+(\d+))?(?:\s|$)/i.exec(line);
    if (approve !== null) {
        const parsed = approve[1] !== undefined ? Number.parseInt(approve[1], 10) : proposedGrant;
        const grant = Number.isFinite(parsed) && parsed > 0 ? parsed : proposedGrant;
        return { granted: true, grant, reason: line };
    }
    const deny = /^DENY(?:\s+(.+))?$/i.exec(line);
    if (deny !== null) {
        const reason = deny[1]?.trim();
        return reason !== undefined && reason.length > 0
            ? { granted: false, reason }
            : { granted: false, reason: line };
    }
    return { granted: false, reason: `unrecognized agent response: ${line.slice(0, 120)}` };
}
