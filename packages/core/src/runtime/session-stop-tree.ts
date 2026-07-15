import type { Client } from '@libsql/client';
import type {
    SessionOwnerControlToken,
    SessionStopErrorCode,
    SessionStopReceiptContract,
    SessionStopScope,
} from '@mission-control/protocol';
import type { SessionOwnerControlClient } from './session-owner-control-client';
import { acquireSessionStopTreeFixedPoint } from './session-stop-tree-fixed-point';
import {
    type CanonicalSessionTreeDescendant,
    type CanonicalSessionTreeResult,
    readCanonicalSessionTree,
    SESSION_STOP_TREE_MAX_SESSIONS,
} from './session-stop-tree-resolver';
import {
    aggregateSessionStopTree,
    descendingDepths,
    failedSessionStopTree,
    failureReceipt,
    remainingTime,
    sessionStopErrorCode,
    terminalTreeSession,
    validateSessionStopTreeInput,
} from './session-stop-tree-support';
import { randomUUID } from 'node:crypto';

export { SESSION_STOP_TREE_MAX_SESSIONS };
export const SESSION_STOP_TREE_MAX_RESCANS = 64;
export const SESSION_STOP_TREE_MAX_TIMEOUT_MS = 300_000;
export const SESSION_STOP_TREE_RETRY_DELAY_MS = 25;

export type SessionStopTreeSessionResult = SessionStopReceiptContract & {
    readonly sessionId: string;
    readonly depth: number;
};

export type SessionStopTreeResult = {
    readonly outcome: 'full' | 'partial' | 'no_op' | 'failed';
    readonly targetSessionId: string;
    readonly scope: SessionStopScope;
    readonly sessions: readonly SessionStopTreeSessionResult[];
    readonly errorCode?: SessionStopErrorCode;
};

export type StopSessionTreeInput = {
    readonly targetSessionId: string;
    readonly scope: SessionStopScope;
    readonly requestId: string;
    readonly operationId: string;
    readonly timeoutMs: number;
    readonly createClient: (sessionId: string) => Promise<SessionOwnerControlClient>;
    readonly client?: Client;
    readonly readTree?: () => Promise<CanonicalSessionTreeResult>;
    readonly monotonicNow?: () => number;
    readonly sleep?: (delayMs: number) => Promise<void>;
};

export type SessionStopTreeHeldBarrier = {
    readonly sessionId: string;
    readonly depth: number;
    readonly requestId: string;
    readonly client: SessionOwnerControlClient;
    readonly token: SessionOwnerControlToken;
};

export async function stopSessionTree(input: StopSessionTreeInput): Promise<SessionStopTreeResult> {
    validateSessionStopTreeInput(input, SESSION_STOP_TREE_MAX_TIMEOUT_MS);
    const monotonicNow = input.monotonicNow ?? (() => performance.now());
    const sleep = input.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const deadline = monotonicNow() + Math.min(input.timeoutMs, SESSION_STOP_TREE_MAX_TIMEOUT_MS);
    const readTree = input.readTree ?? (() => readCanonicalSessionTree(requireClient(input), input.targetSessionId));
    const initial = await readTree();
    if (!initial.ok) return failedSessionStopTree(input, initial.errorCode);

    const operationIds = new Map<string, string>([[input.targetSessionId, input.operationId]]);
    const held = new Map<string, SessionStopTreeHeldBarrier>();
    const failed = new Map<string, SessionStopTreeSessionResult>();
    const settled = new Map<string, SessionStopTreeSessionResult>();
    const observedParents = new Map(initial.nodes.map((node) => [node.sessionId, node.parentSessionId]));
    try {
        const targetNode = initial.nodes.find(({ sessionId }) => sessionId === input.targetSessionId);
        const targetIsTerminal = targetNode?.status === 'stopped' || targetNode?.status === 'failed';
        const target = targetIsTerminal
            ? undefined
            : await acquireBarrier(input, input.targetSessionId, 0, deadline, monotonicNow, operationIds);
        if (target !== undefined && 'errorCode' in target) return failedSessionStopTree(input, target.errorCode);
        if (target !== undefined) held.set(input.targetSessionId, target);

        switch (input.scope) {
            case 'only': {
                const result =
                    target === undefined
                        ? terminalTreeSession(input.targetSessionId, 0, input.requestId, input.operationId)
                        : { ...(await stopBarrier(target)), sessionId: input.targetSessionId, depth: 0 };
                return aggregateSessionStopTree(input, [result]);
            }
            case 'tree':
            case 'children':
                break;
            default:
                return unreachableScope(input.scope);
        }

        const fixedPoint = await acquireSessionStopTreeFixedPoint({
            input,
            readTree,
            deadline,
            monotonicNow,
            sleep,
            observedParents,
            held,
            failed,
            settled,
            maxRescans: SESSION_STOP_TREE_MAX_RESCANS,
            retryDelayMs: SESSION_STOP_TREE_RETRY_DELAY_MS,
            operationId: (sessionId) => operationIdFor(sessionId, input.targetSessionId, operationIds),
            acquire: (node) => acquireBarrier(input, node.sessionId, node.depth, deadline, monotonicNow, operationIds),
        });
        if (!fixedPoint.ok) return failedSessionStopTree(input, fixedPoint.errorCode);

        const results = await stopLeafFirst(fixedPoint.descendants, held, failed, settled);
        switch (input.scope) {
            case 'tree': {
                results.push(
                    target === undefined
                        ? terminalTreeSession(input.targetSessionId, 0, input.requestId, input.operationId)
                        : { ...(await stopBarrier(target)), sessionId: input.targetSessionId, depth: 0 },
                );
                break;
            }
            case 'children':
                break;
            default:
                return unreachableScope(input.scope);
        }
        return aggregateSessionStopTree(input, results);
    } finally {
        await releaseAll([...held.values()], sleep);
    }
}

async function acquireBarrier(
    input: StopSessionTreeInput,
    sessionId: string,
    depth: number,
    deadline: number,
    monotonicNow: () => number,
    operationIds: Map<string, string>,
): Promise<SessionStopTreeHeldBarrier | { readonly errorCode: SessionStopErrorCode }> {
    const timeoutMs = remainingTime(deadline, monotonicNow);
    if (timeoutMs <= 0) return { errorCode: 'stop_timeout' };
    try {
        const client = await input.createClient(sessionId);
        const remainingMs = remainingTime(deadline, monotonicNow);
        if (remainingMs <= 0) return { errorCode: 'stop_timeout' };
        const operationId = operationIdFor(sessionId, input.targetSessionId, operationIds);
        const acquired = await client.acquire({
            sessionId,
            requestId: input.requestId,
            operationId,
            kind: 'exact_session_stop',
            ...(sessionId === input.targetSessionId && input.scope === 'children'
                ? { barrierKind: 'child_spawn_only' as const }
                : {}),
            timeoutMs: remainingMs,
        });
        return { sessionId, depth, requestId: input.requestId, client, token: acquired.token };
    } catch (error: unknown) {
        return { errorCode: sessionStopErrorCode(error) };
    }
}

async function stopLeafFirst(
    descendants: readonly CanonicalSessionTreeDescendant[],
    held: ReadonlyMap<string, SessionStopTreeHeldBarrier>,
    failed: ReadonlyMap<string, SessionStopTreeSessionResult>,
    settled: ReadonlyMap<string, SessionStopTreeSessionResult>,
): Promise<SessionStopTreeSessionResult[]> {
    const results: SessionStopTreeSessionResult[] = [];
    for (const depth of descendingDepths(descendants)) {
        const siblings = descendants.filter((node) => node.depth === depth);
        const receipts = await Promise.all(
            siblings.map(async (node) => {
                const priorFailure = failed.get(node.sessionId);
                if (priorFailure !== undefined) return priorFailure;
                const priorSettlement = settled.get(node.sessionId);
                if (priorSettlement !== undefined) return priorSettlement;
                const barrier = held.get(node.sessionId);
                if (barrier === undefined) return undefined;
                return { ...(await stopBarrier(barrier)), sessionId: node.sessionId, depth: node.depth };
            }),
        );
        results.push(...receipts.filter((receipt): receipt is SessionStopTreeSessionResult => receipt !== undefined));
    }
    return results;
}

async function stopBarrier(barrier: SessionStopTreeHeldBarrier): Promise<SessionStopReceiptContract> {
    try {
        return await barrier.client.stop(barrier.token);
    } catch (error: unknown) {
        return failureReceipt(barrier.requestId, barrier.token.operationId, sessionStopErrorCode(error));
    }
}

async function releaseAll(
    barriers: readonly SessionStopTreeHeldBarrier[],
    sleep: (delayMs: number) => Promise<void>,
): Promise<void> {
    for (const barrier of [...barriers].reverse()) {
        try {
            await barrier.client.release(barrier.token);
        } catch {
            await sleep(SESSION_STOP_TREE_RETRY_DELAY_MS);
            await barrier.client.release(barrier.token).catch(() => undefined);
        }
    }
}

function operationIdFor(sessionId: string, targetId: string, operationIds: Map<string, string>): string {
    const existing = operationIds.get(sessionId);
    if (existing !== undefined) return existing;
    const created = sessionId === targetId ? (operationIds.get(targetId) ?? randomUUID()) : randomUUID();
    operationIds.set(sessionId, created);
    return created;
}

function requireClient(input: StopSessionTreeInput): Client {
    if (input.client === undefined) throw new TypeError('session stop tree requires a database client or readTree');
    return input.client;
}

function unreachableScope(scope: never): never {
    throw new TypeError(`unsupported session stop scope: ${scope}`);
}
