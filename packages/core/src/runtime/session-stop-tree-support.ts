import type { SessionStopErrorCode, SessionStopReceiptContract } from '@mission-control/protocol';
import type { SessionStopTreeResult, SessionStopTreeSessionResult, StopSessionTreeInput } from './session-stop-tree.js';
import type { CanonicalSessionTreeDescendant, CanonicalSessionTreeResult } from './session-stop-tree-resolver.js';

const emptyAffected = {
    runs: 0,
    approvals: 0,
    sessionAwaits: 0,
    sessionInputs: 0,
    missionRuns: 0,
    asyncJobs: 0,
    toolCalls: 0,
} as const;

export function parentsRemainStable(
    tree: Extract<CanonicalSessionTreeResult, { ok: true }>,
    observed: Map<string, string | null>,
): boolean {
    const current = new Set(tree.nodes.map(({ sessionId }) => sessionId));
    if ([...observed.keys()].some((sessionId) => !current.has(sessionId))) return false;
    for (const node of tree.nodes) {
        const parent = observed.get(node.sessionId);
        if (parent !== undefined && parent !== node.parentSessionId) return false;
        observed.set(node.sessionId, node.parentSessionId);
    }
    return true;
}

export function aggregateSessionStopTree(
    input: StopSessionTreeInput,
    sessions: readonly SessionStopTreeSessionResult[],
): SessionStopTreeResult {
    const failures = sessions.filter(({ outcome }) => outcome === 'failed').length;
    const successes = sessions.length - failures;
    const changed = sessions.some(({ outcome }) => outcome === 'interrupted');
    const outcome = failures > 0 ? (successes > 0 ? 'partial' : 'failed') : changed ? 'full' : 'no_op';
    return { outcome, targetSessionId: input.targetSessionId, scope: input.scope, sessions };
}

export function failedSessionStopTree(
    input: StopSessionTreeInput,
    errorCode: SessionStopErrorCode,
): SessionStopTreeResult {
    return { outcome: 'failed', targetSessionId: input.targetSessionId, scope: input.scope, sessions: [], errorCode };
}

export function failedTreeSession(
    node: CanonicalSessionTreeDescendant,
    input: StopSessionTreeInput,
    code: SessionStopErrorCode,
    operationId = input.operationId,
): SessionStopTreeSessionResult {
    return {
        ...failureReceipt(input.requestId, operationId, code),
        sessionId: node.sessionId,
        depth: node.depth,
    };
}

export function failureReceipt(
    requestId: string,
    operationId: string,
    errorCode: SessionStopErrorCode,
): SessionStopReceiptContract {
    return { outcome: 'failed', requestId, operationId, affected: emptyAffected, errorCode };
}

export function terminalTreeSession(
    sessionId: string,
    depth: number,
    requestId: string,
    operationId: string,
): SessionStopTreeSessionResult {
    return {
        outcome: 'already_terminal',
        requestId,
        operationId,
        affected: emptyAffected,
        sessionId,
        depth,
    };
}

export function sessionStopErrorCode(error: unknown): SessionStopErrorCode {
    if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
        return 'owner_unreachable';
    }
    switch (error.code) {
        case 'session_not_found':
        case 'session_owned_elsewhere':
        case 'owner_unreachable':
        case 'session_stopping':
        case 'stop_timeout':
        case 'unstable_session_tree':
            return error.code;
        case 'owner_fenced':
        case 'token_invalid':
            return 'session_owned_elsewhere';
        default:
            return 'owner_unreachable';
    }
}

export function ascendingDepths(nodes: readonly CanonicalSessionTreeDescendant[]): number[] {
    return [...new Set(nodes.map(({ depth }) => depth))].sort((left, right) => left - right);
}

export function descendingDepths(nodes: readonly CanonicalSessionTreeDescendant[]): number[] {
    return ascendingDepths(nodes).reverse();
}

export function remainingTime(deadline: number, monotonicNow: () => number): number {
    return Math.max(0, Math.floor(deadline - monotonicNow()));
}

export function validateSessionStopTreeInput(input: StopSessionTreeInput, maxTimeoutMs: number): void {
    if (input.targetSessionId.length === 0 || input.requestId.length === 0 || input.operationId.length === 0) {
        throw new TypeError('session stop tree identifiers must be nonempty');
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > maxTimeoutMs) {
        throw new TypeError('session stop tree timeout is out of range');
    }
}
