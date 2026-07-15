import type { SessionStopErrorCode } from '@mission-control/protocol';
import type {
    SessionStopTreeHeldBarrier,
    SessionStopTreeSessionResult,
    StopSessionTreeInput,
} from './session-stop-tree';
import type { CanonicalSessionTreeDescendant, CanonicalSessionTreeResult } from './session-stop-tree-resolver';
import {
    ascendingDepths,
    failedTreeSession,
    parentsRemainStable,
    remainingTime,
    terminalTreeSession,
} from './session-stop-tree-support';
import { encodeCanonicalSessionTree } from './session-tree-token';

type BarrierAcquisition = SessionStopTreeHeldBarrier | { readonly errorCode: SessionStopErrorCode };

export async function acquireSessionStopTreeFixedPoint(context: {
    readonly input: StopSessionTreeInput;
    readonly readTree: () => Promise<CanonicalSessionTreeResult>;
    readonly deadline: number;
    readonly monotonicNow: () => number;
    readonly sleep: (delayMs: number) => Promise<void>;
    readonly observedParents: Map<string, string | null>;
    readonly held: Map<string, SessionStopTreeHeldBarrier>;
    readonly failed: Map<string, SessionStopTreeSessionResult>;
    readonly settled: Map<string, SessionStopTreeSessionResult>;
    readonly maxRescans: number;
    readonly retryDelayMs: number;
    readonly operationId: (sessionId: string) => string;
    readonly acquire: (node: CanonicalSessionTreeDescendant) => Promise<BarrierAcquisition>;
}): Promise<
    | { readonly ok: true; readonly descendants: readonly CanonicalSessionTreeDescendant[] }
    | { readonly ok: false; readonly errorCode: SessionStopErrorCode }
> {
    let latest: readonly CanonicalSessionTreeDescendant[] = [];
    let previousFingerprint: string | undefined;
    for (let rescan = 0; rescan < context.maxRescans; rescan += 1) {
        if (context.monotonicNow() >= context.deadline) return { ok: false, errorCode: 'stop_timeout' };
        const tree = await context.readTree();
        if (!tree.ok) return { ok: false, errorCode: tree.errorCode };
        if (!parentsRemainStable(tree, context.observedParents)) {
            return { ok: false, errorCode: 'unstable_session_tree' };
        }
        latest = tree.descendants;
        const fingerprint = encodeCanonicalSessionTree(latest);
        const pending = latest.filter(
            ({ sessionId }) =>
                !context.held.has(sessionId) && !context.failed.has(sessionId) && !context.settled.has(sessionId),
        );
        if (pending.length === 0 && fingerprint === previousFingerprint) {
            return { ok: true, descendants: latest };
        }
        previousFingerprint = fingerprint;
        await acquirePendingDepths(context, pending);
        await context.sleep(Math.min(context.retryDelayMs, remainingTime(context.deadline, context.monotonicNow)));
    }
    return { ok: false, errorCode: 'unstable_session_tree' };
}

async function acquirePendingDepths(
    context: Parameters<typeof acquireSessionStopTreeFixedPoint>[0],
    pending: readonly CanonicalSessionTreeDescendant[],
): Promise<void> {
    for (const depth of ascendingDepths(pending)) {
        const siblings = pending.filter((node) => node.depth === depth);
        markUnfencedBranches(context, siblings);
        markTerminalSessions(context, siblings);
        const fenceable = siblings.filter(
            ({ sessionId }) => !context.failed.has(sessionId) && !context.settled.has(sessionId),
        );
        const acquired = await Promise.all(fenceable.map(context.acquire));
        for (let index = 0; index < fenceable.length; index += 1) {
            const node = fenceable[index];
            const barrier = acquired[index];
            if (node === undefined || barrier === undefined) continue;
            if ('errorCode' in barrier) {
                context.failed.set(
                    node.sessionId,
                    failedTreeSession(node, context.input, barrier.errorCode, context.operationId(node.sessionId)),
                );
            } else context.held.set(node.sessionId, barrier);
        }
    }
}

function markTerminalSessions(
    context: Parameters<typeof acquireSessionStopTreeFixedPoint>[0],
    siblings: readonly CanonicalSessionTreeDescendant[],
): void {
    for (const node of siblings) {
        if (context.failed.has(node.sessionId) || (node.status !== 'stopped' && node.status !== 'failed')) continue;
        context.settled.set(
            node.sessionId,
            terminalTreeSession(
                node.sessionId,
                node.depth,
                context.input.requestId,
                context.operationId(node.sessionId),
            ),
        );
    }
}

function markUnfencedBranches(
    context: Parameters<typeof acquireSessionStopTreeFixedPoint>[0],
    siblings: readonly CanonicalSessionTreeDescendant[],
): void {
    for (const node of siblings) {
        const parentFailure = node.parentSessionId === null ? undefined : context.failed.get(node.parentSessionId);
        if (parentFailure === undefined) continue;
        context.failed.set(
            node.sessionId,
            failedTreeSession(
                node,
                context.input,
                parentFailure.errorCode ?? 'owner_unreachable',
                context.operationId(node.sessionId),
            ),
        );
    }
}
