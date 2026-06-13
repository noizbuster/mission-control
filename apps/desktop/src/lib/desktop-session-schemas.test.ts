import { describe, expect, it } from 'vitest';
import {
    DesktopSessionSnapshotSchema,
    DesktopSessionSummarySchema,
    parseDesktopSessionLogPayload,
} from './desktop-session-schemas.js';

describe('desktop session schemas', () => {
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
                sessionId: 'session_summary',
                fileName: 'session_summary.jsonl',
                state: 'available',
                eventCount: 12,
                lockState: 'live',
                diagnostics: [],
                sessionTree,
                stats,
            }),
        ).toMatchObject({
            sessionTree,
            stats,
        });

        expect(
            DesktopSessionSnapshotSchema.parse({
                sessionId: 'session_summary',
                state: 'available',
                eventCount: 12,
                graphIds: ['coding-agent'],
                diagnostics: [],
                sessionTree,
                stats,
            }),
        ).toMatchObject({
            sessionTree,
            stats,
        });
    });

    it('rejects unknown workspace trust states in desktop session payloads', () => {
        const summary = {
            sessionId: 'session_invalid_trust',
            fileName: 'session_invalid_trust.jsonl',
            state: 'available',
            eventCount: 1,
            diagnostics: [],
            sessionTree: {
                workspaceTrust: 'maybe',
                entryCount: 1,
                branchCount: 1,
            },
        };
        const snapshot = {
            sessionId: 'session_invalid_trust',
            state: 'available',
            eventCount: 1,
            graphIds: [],
            diagnostics: [],
            sessionTree: {
                workspaceTrust: 'maybe',
                entryCount: 1,
                branchCount: 1,
            },
        };

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
