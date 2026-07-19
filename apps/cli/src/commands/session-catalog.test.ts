import { openLocalSessionEventStore } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    type CliSessionCatalogEntry,
    filterCatalogEntriesByWorkspace,
    formatSessionCatalogEntry,
    listSessionCatalogEntries,
    listSessionCatalogEntriesForWorkspace,
} from './session-catalog';
import { createSessionLog, useTempDataDir } from './session-import-export-fixtures';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKSPACE_ROOT = '/workspace/mission-control';

const baseEntry: CliSessionCatalogEntry = {
    sessionId: 'session_base',
    status: 'stopped',
    eventCount: 0,
    messageCount: 0,
    trustStatus: 'unknown',
    diagnostics: [],
};

describe('filterCatalogEntriesByWorkspace', () => {
    it('keeps an entry whose cwd equals the normalized root', () => {
        const entry: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_cwd_match',
            cwd: WORKSPACE_ROOT,
        };

        const result = filterCatalogEntriesByWorkspace([entry], WORKSPACE_ROOT);

        expect(result).toEqual([entry]);
    });

    it('keeps an entry whose trustedRoot equals the root when cwd is undefined', () => {
        const entry: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_trusted_root_match',
            trustedRoot: WORKSPACE_ROOT,
        };

        const result = filterCatalogEntriesByWorkspace([entry], WORKSPACE_ROOT);

        expect(result).toEqual([entry]);
    });

    it('drops an entry whose cwd points at a different project', () => {
        const entry: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_other_project',
            cwd: '/workspace/some-other-project',
        };

        const result = filterCatalogEntriesByWorkspace([entry], WORKSPACE_ROOT);

        expect(result).toEqual([]);
    });

    it('drops legacy entries where both cwd and trustedRoot are undefined', () => {
        const absentKeys: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_legacy_absent',
        };
        const explicitUndefined: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_legacy_explicit',
            cwd: undefined,
            trustedRoot: undefined,
        };

        const result = filterCatalogEntriesByWorkspace([absentKeys, explicitUndefined], WORKSPACE_ROOT);

        expect(result).toEqual([]);
    });

    it('preserves the input order (updatedAt desc, undefined last) without mutating the input', () => {
        const newest: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_newest',
            cwd: WORKSPACE_ROOT,
            updatedAt: '2026-06-13T10:00:03.000Z',
        };
        const oldest: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_oldest',
            cwd: WORKSPACE_ROOT,
            updatedAt: '2026-06-13T10:00:00.000Z',
        };
        const undefinedUpdated: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_no_updated',
            trustedRoot: WORKSPACE_ROOT,
        };
        const dropped: CliSessionCatalogEntry = {
            ...baseEntry,
            sessionId: 'session_other',
            cwd: '/workspace/dropped',
            updatedAt: '2026-06-13T10:00:09.000Z',
        };
        const input: readonly CliSessionCatalogEntry[] = [newest, oldest, undefinedUpdated, dropped];

        const result = filterCatalogEntriesByWorkspace(input, WORKSPACE_ROOT);

        expect(result).toEqual([newest, oldest, undefinedUpdated]);
        // Does not mutate the input array or its element references.
        expect(input).toEqual([newest, oldest, undefinedUpdated, dropped]);
        expect(result[0]).toBe(newest);
    });

    it('returns an empty array for empty input', () => {
        const result = filterCatalogEntriesByWorkspace([], WORKSPACE_ROOT);

        expect(result).toEqual([]);
    });
});

describe('listSessionCatalogEntriesForWorkspace', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('matches a session whose stored cwd is the realpath target of a symlinked workspace root', async () => {
        const dataDir = await useTempDataDir();
        const realWorkspace = await mkdtemp(join(tmpdir(), 'mission-control-catalog-real-'));
        const symlinkWorkspace = join(tmpdir(), `mission-control-catalog-link-${Date.now()}`);
        await symlink(realWorkspace, symlinkWorkspace);
        const otherWorkspace = await mkdtemp(join(tmpdir(), 'mission-control-catalog-other-'));
        const matchingSessionId = 'session_catalog_symlink_match';
        const otherSessionId = 'session_catalog_symlink_other';
        try {
            // The stored cwd is the realpath target; the symlink path is a different string.
            expect(await realpath(symlinkWorkspace)).toBe(realWorkspace);
            expect(symlinkWorkspace).not.toBe(realWorkspace);

            await writeFile(
                join(dataDir, 'sessions', `${matchingSessionId}.jsonl`),
                createSessionLog({
                    sessionId: matchingSessionId,
                    createdAt: '2026-06-13T10:00:00.000Z',
                    updatedAt: '2026-06-13T10:00:03.000Z',
                    cwd: realWorkspace,
                    workspaceTrust: 'unknown',
                    name: 'Symlinked',
                    activeLeafId: 'entry_match',
                }),
                'utf8',
            );
            await writeFile(
                join(dataDir, 'sessions', `${otherSessionId}.jsonl`),
                createSessionLog({
                    sessionId: otherSessionId,
                    createdAt: '2026-06-13T10:00:00.000Z',
                    updatedAt: '2026-06-13T10:00:09.000Z',
                    cwd: otherWorkspace,
                    workspaceTrust: 'unknown',
                    name: 'Other project',
                    activeLeafId: 'entry_other',
                }),
                'utf8',
            );

            // Passing the symlink proves realpath normalization bridges symlink -> real target.
            const entries = await listSessionCatalogEntriesForWorkspace(symlinkWorkspace);
            const sessionIds = entries.map((entry) => entry.sessionId);

            expect(sessionIds).toContain(matchingSessionId);
            expect(sessionIds).not.toContain(otherSessionId);
        } finally {
            await rm(symlinkWorkspace, { force: true });
            await rm(realWorkspace, { recursive: true, force: true });
            await rm(otherWorkspace, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('falls back to resolve() (no throw) when the workspace root does not exist on disk', async () => {
        const dataDir = await useTempDataDir();
        try {
            const entries = await listSessionCatalogEntriesForWorkspace(
                join(tmpdir(), 'mission-control-catalog-nonexistent'),
            );

            expect(entries).toEqual([]);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('returns nothing when the catalog has no sessions', async () => {
        const dataDir = await useTempDataDir();
        await mkdir(join(dataDir, 'sessions', 'empty-nested'), { recursive: true });
        try {
            const entries = await listSessionCatalogEntriesForWorkspace(WORKSPACE_ROOT);

            expect(entries).toEqual([]);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('projects blocked approval as status awaiting with approval reason', async () => {
        // Given: a durable session whose latest run is blocked_on_approval with a pending approval.
        const dataDir = await useTempDataDir();
        const sessionId = 'session_catalog_blocked_approval';
        try {
            await writeDurableSession(dataDir, sessionId, blockedApprovalEvents(sessionId));

            // When: the public catalog lists sessions from the projection store.
            const entries = await listSessionCatalogEntries();
            const entry = entries.find((candidate) => candidate.sessionId === sessionId);

            // Then: catalog status is awaiting and awaiting.reason is approval.
            expect(entry).toBeDefined();
            if (entry === undefined) {
                throw new Error('expected blocked approval catalog entry');
            }
            expect(entry).toMatchObject({
                sessionId,
                status: 'awaiting',
                awaiting: {
                    reason: 'approval',
                    source: {
                        approvalId: 'approval_patch',
                        runId: 'run_1',
                        toolCallId: 'patch_call',
                    },
                },
            });
            expect(typeof entry.status).toBe('string');
            expect(formatSessionCatalogEntry(entry)).toContain(
                'status=awaiting approval (approval=approval_patch,run=run_1,tool=patch_call)',
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

async function writeDurableSession(
    dataDir: string,
    sessionId: string,
    events: readonly AgentEvent[],
): Promise<void> {
    const store = await openLocalSessionEventStore({
        dataDir,
        sessionId,
        now: () => events[0]?.timestamp ?? '2026-07-04T10:00:00.000Z',
        createEventId: (_event, sequence) => `evt_${sessionId}_${sequence}`,
    });
    try {
        for (const event of events) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

function blockedApprovalEvents(sessionId: string): readonly AgentEvent[] {
    return [
        {
            type: 'session.started',
            timestamp: '2026-07-04T10:00:00.000Z',
            sessionId,
            message: 'session started',
        },
        {
            type: 'run.started',
            timestamp: '2026-07-04T10:00:01.000Z',
            sessionId,
            message: 'run started',
            run: { command: 'run', state: 'running', runId: 'run_1' },
        },
        {
            type: 'approval.requested',
            timestamp: '2026-07-04T10:00:02.000Z',
            sessionId,
            message: 'approval pending',
            approvalRecord: {
                approvalId: 'approval_patch',
                requestId: 'permission_patch',
                policyDecision: 'requires_approval',
                state: 'pending',
                subject: { kind: 'tool', id: 'file.patch' },
                requestedAt: '2026-07-04T10:00:02.000Z',
            },
        },
        {
            type: 'run.blocked',
            timestamp: '2026-07-04T10:00:03.000Z',
            sessionId,
            message: 'waiting for approval: file.patch',
            run: {
                command: 'run',
                state: 'blocked_on_approval',
                runId: 'run_1',
                reason: 'waiting for approval: file.patch',
                errorCode: 'tool_failed',
                toolCallId: 'patch_call',
            },
        },
    ];
}
