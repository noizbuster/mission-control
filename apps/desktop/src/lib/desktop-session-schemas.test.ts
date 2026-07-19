import type { SessionStatus } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    DesktopSessionSnapshotSchema,
    DesktopSessionSummarySchema,
    parseDesktopSessionLogPayload,
} from './desktop-session-schemas';

type SessionPayloadFields = {
    readonly sessionId: string;
    readonly status?: SessionStatus;
    readonly statusText?: string;
    readonly awaiting?: unknown;
    readonly eventCount?: number;
    readonly graphIds?: readonly string[];
    readonly sessionTree?: unknown;
    readonly stats?: unknown;
};

function summaryPayload(input: SessionPayloadFields) {
    return {
        ...sharedPayload(input),
        fileName: `${input.sessionId}.jsonl`,
    };
}

function snapshotPayload(input: SessionPayloadFields) {
    return {
        ...sharedPayload(input),
        graphIds: input.graphIds ?? [],
    };
}

function sharedPayload(input: SessionPayloadFields) {
    return {
        sessionId: input.sessionId,
        state: 'available' as const,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.statusText === undefined ? {} : { statusText: input.statusText }),
        ...(input.awaiting === undefined ? {} : { awaiting: input.awaiting }),
        eventCount: input.eventCount ?? 1,
        diagnostics: [],
        ...(input.sessionTree === undefined ? {} : { sessionTree: input.sessionTree }),
        ...(input.stats === undefined ? {} : { stats: input.stats }),
    };
}

describe('desktop session schemas', () => {
    it('characterizes legacy lifecycle statuses on summaries and snapshots', () => {
        for (const status of ['idle', 'running', 'stopped', 'failed'] as const) {
            const fields = {
                sessionId: `session_${status}`,
                status,
            };

            expect(DesktopSessionSummarySchema.parse(summaryPayload(fields))).toEqual(summaryPayload(fields));
            expect(DesktopSessionSnapshotSchema.parse(snapshotPayload(fields))).toEqual(snapshotPayload(fields));
        }
    });

    it('accepts coding-agent session tree and stats metadata on summaries and snapshots', () => {
        const sessionTree = {
            sessionName: 'Coding parity session',
            cwd: '/workspace/mission-control',
            trustedRoot: '/workspace/mission-control',
            workspaceTrust: 'trusted',
            parentSessionId: 'session_parent',
            activeLeafId: 'entry_active',
            entryCount: 3,
            branchCount: 2,
            forkSourceSessionId: 'session_base',
        };
        const stats = {
            eventCount: 12,
            pendingApprovalCount: 1,
            blockedRunCount: 1,
            commandEventCount: 2,
            diffEventCount: 1,
            toolOutcomeCount: 2,
        };

        expect(
            DesktopSessionSummarySchema.parse({
                ...summaryPayload({
                    sessionId: 'session_summary',
                    eventCount: 12,
                    sessionTree,
                    stats,
                }),
            }),
        ).toMatchObject({
            sessionTree,
            stats,
        });

        expect(
            DesktopSessionSnapshotSchema.parse(
                snapshotPayload({
                    sessionId: 'session_summary',
                    eventCount: 12,
                    graphIds: ['coding-agent'],
                    sessionTree,
                    stats,
                }),
            ),
        ).toMatchObject({
            sessionTree,
            stats,
        });
    });

    it('parses imported legacy sessions and SQLite-native awaiting sessions without loose payloads', () => {
        const awaitingCases = [
            {
                reason: 'approval',
                source: { approvalId: 'approval_patch', runId: 'run_1', toolCallId: 'patch_call' },
            },
            {
                reason: 'user_input',
                source: { runId: 'run_waiting' },
            },
            {
                reason: 'subagent',
                source: { jobId: 'job_child', childSessionId: 'session_child' },
            },
        ] as const;

        expect(DesktopSessionSummarySchema.parse(summaryPayload({ sessionId: 'session_legacy' }))).toEqual(
            summaryPayload({ sessionId: 'session_legacy' }),
        );
        for (const awaiting of awaitingCases) {
            const fields = {
                sessionId: `session_awaiting_${awaiting.reason}`,
                status: 'awaiting',
                statusText: `awaiting ${awaiting.reason}`,
                awaiting,
            } as const;

            expect(DesktopSessionSummarySchema.parse(summaryPayload(fields))).toEqual(summaryPayload(fields));
            expect(DesktopSessionSnapshotSchema.parse(snapshotPayload(fields))).toEqual(snapshotPayload(fields));
        }
    });

    it('rejects malformed awaiting reason/source pairs deterministically', () => {
        const malformedAwaitingDetails = [
            {
                reason: 'approval',
                source: {
                    runId: 'run_without_approval',
                },
            },
            {
                reason: 'user_input',
                source: {
                    approvalId: 'approval_wrong',
                },
            },
            {
                reason: 'subagent',
                source: {
                    runId: 'run_without_child',
                },
            },
            {
                kind: 'approval',
                source: { approvalId: 'approval_patch', runId: 'run_approval' },
            },
        ] as const;

        for (const [index, awaiting] of malformedAwaitingDetails.entries()) {
            const fields = { sessionId: `session_invalid_${index}`, status: 'awaiting', awaiting } as const;
            expect(DesktopSessionSummarySchema.safeParse(summaryPayload(fields)).success).toBe(false);
            expect(DesktopSessionSnapshotSchema.safeParse(snapshotPayload(fields)).success).toBe(false);
        }
        expect(
            DesktopSessionSnapshotSchema.safeParse(
                snapshotPayload({
                    sessionId: 'session_invalid_status',
                    status: 'running',
                    awaiting: { reason: 'user_input', source: { runId: 'run_wrong' } },
                }),
            ).success,
        ).toBe(false);
    });

    it('rejects unknown workspace trust states in desktop session payloads', () => {
        const sessionTree = {
            workspaceTrust: 'maybe',
            entryCount: 1,
            branchCount: 1,
        };
        const summary = summaryPayload({
            sessionId: 'session_invalid_trust',
            sessionTree,
        });
        const snapshot = snapshotPayload({
            sessionId: 'session_invalid_trust',
            sessionTree,
        });

        expect(DesktopSessionSummarySchema.safeParse(summary).success).toBe(false);
        expect(DesktopSessionSnapshotSchema.safeParse(snapshot).success).toBe(false);
    });

    it('keeps corrupt payload diagnostics when replay metadata is present', () => {
        const log = parseDesktopSessionLogPayload({
            sessionId: 'session_log_tree',
            state: 'available',
            contents: 'jsonl',
            diagnostics: [],
            envelopes: [
                {
                    eventId: 'event_0',
                    sequence: 0,
                    createdAt: '2026-06-13T00:00:00.000Z',
                    sessionId: 'session_log_tree',
                    durability: 'durable',
                    event: {
                        type: 'session.metadata.updated',
                        timestamp: '2026-06-13T00:00:00.000Z',
                        sessionId: 'session_log_tree',
                        message: 'session metadata updated',
                        sessionTree: {
                            kind: 'metadata',
                            workspaceTrust: 'trusted',
                            trustedRoot: '/workspace/mission-control',
                        },
                    },
                },
                {
                    eventId: 'event_1',
                    sequence: 0,
                    createdAt: '2026-06-13T00:00:01.000Z',
                    sessionId: 'session_log_tree',
                    durability: 'durable',
                    event: {
                        type: 'run.blocked',
                        timestamp: '2026-06-13T00:00:01.000Z',
                        sessionId: 'session_log_tree',
                        message: 'waiting for approval: file.patch',
                        run: {
                            command: 'run',
                            state: 'blocked_on_approval',
                            runId: 'run_blocked',
                        },
                    },
                },
            ],
        });

        expect(log.state).toBe('corrupt');
        expect(log.diagnostics).toEqual([
            {
                code: 'corrupt_envelope',
                message: 'event sequence is not strictly increasing',
                lineNumber: 3,
            },
        ]);
    });
});
