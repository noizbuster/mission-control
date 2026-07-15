import type { SessionOwnerControlClient } from './session-owner-control-client';
import type { StopSessionTreeInput } from './session-stop-tree';
import { resolveCanonicalSessionTree } from './session-stop-tree-resolver';

const emptyAffected = {
    runs: 0,
    approvals: 0,
    sessionAwaits: 0,
    sessionInputs: 0,
    missionRuns: 0,
    asyncJobs: 0,
    toolCalls: 0,
} as const;

export function createSessionStopTreeHarness(
    parents: Readonly<Record<string, string | null>>,
    failedAcquire = new Set<string>(),
) {
    const events: string[] = [];
    const acquisitions: Array<{ readonly sessionId: string; readonly barrierKind: string }> = [];
    const failedStops = new Set<string>();
    const harness = {
        events,
        acquisitions,
        failedStops,
        snapshots: () => parents,
        input: (scope: StopSessionTreeInput['scope']): StopSessionTreeInput => ({
            targetSessionId: 'root',
            scope,
            requestId: 'tree-request',
            operationId: 'tree-operation',
            timeoutMs: 15_000,
            monotonicNow: () => 0,
            sleep: async () => undefined,
            readTree: async () => treeFromParents(harness.snapshots()),
            createClient: async (sessionId: string): Promise<SessionOwnerControlClient> => ({
                acquire: async (input) => {
                    events.push(`acquire:${sessionId}`);
                    acquisitions.push({ sessionId, barrierKind: input.barrierKind ?? 'all_mutations' });
                    if (failedAcquire.has(sessionId)) {
                        throw Object.assign(new Error('offline'), { code: 'owner_unreachable' });
                    }
                    return {
                        token: {
                            value: 'a'.repeat(43),
                            operationId: input.operationId,
                            sessionId,
                            kind: 'exact_session_stop',
                            ownerId: `owner-${sessionId}`,
                            ownerEpoch: 1,
                            timeoutMs: input.timeoutMs,
                        },
                    };
                },
                stop: async (token) => {
                    events.push(`stop:${sessionId}`);
                    return failedStops.has(sessionId)
                        ? {
                              outcome: 'failed',
                              requestId: 'tree-request',
                              operationId: token.operationId,
                              affected: emptyAffected,
                              errorCode: 'stop_timeout',
                          }
                        : {
                              outcome: 'interrupted',
                              requestId: 'tree-request',
                              operationId: token.operationId,
                              affected: { ...emptyAffected, runs: 1 },
                          };
                },
                release: async () => {
                    events.push(`release:${sessionId}`);
                    return { released: true };
                },
            }),
        }),
    };
    return harness;
}

function treeFromParents(parents: Readonly<Record<string, string | null>>) {
    return resolveCanonicalSessionTree({
        targetSessionId: 'root',
        sessions: Object.entries(parents).map(([sessionId, parentSessionId]) => ({ sessionId, parentSessionId })),
        relations: [],
    });
}
