import { ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import { createSessionLog, fixedNow, useTempDataDir } from './session-import-export-fixtures.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session stats commands', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists deterministic session stats including cwd name trust active leaf and parent session', async () => {
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-workspace-'));
        const sessionId = 'session_stats_surface';
        await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await writeFile(
            join(dataDir, 'sessions', `${sessionId}.jsonl`),
            createSessionLog({
                sessionId,
                createdAt: '2026-06-13T10:00:00.000Z',
                updatedAt: '2026-06-13T10:00:03.000Z',
                cwd: workspaceRoot,
                workspaceTrust: 'trusted',
                name: 'Stats demo',
                parentSessionId: 'session_parent',
                activeLeafId: 'entry_branch',
            }),
            'utf8',
        );

        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));
        const showOutput = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));

        expect(listOutput).toContain(`cwd=${workspaceRoot}`);
        expect(listOutput).toContain('name=Stats demo');
        expect(listOutput).toContain('created=2026-06-13T10:00:00.000Z');
        expect(listOutput).toContain('updated=2026-06-13T10:00:03.000Z');
        expect(listOutput).toContain('messages=4');
        expect(listOutput).toContain('active=entry_branch');
        expect(listOutput).toContain('trust=trusted');
        expect(listOutput).toContain('parent=session_parent');
        expect(showOutput).toMatchObject({
            sessionId,
            cwd: workspaceRoot,
            name: 'Stats demo',
            createdAt: '2026-06-13T10:00:00.000Z',
            updatedAt: '2026-06-13T10:00:03.000Z',
            messageCount: 4,
            activeLeafId: 'entry_branch',
            trustStatus: 'trusted',
            parentSessionId: 'session_parent',
        });
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('prefers durable workspace trust from session metadata over ambient trust store state', async () => {
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-trust-workspace-'));
        const sessionId = 'session_stats_durable_trust';
        await writeFile(
            join(dataDir, 'sessions', `${sessionId}.jsonl`),
            createSessionLog({
                sessionId,
                createdAt: '2026-06-13T10:00:00.000Z',
                updatedAt: '2026-06-13T10:00:03.000Z',
                cwd: workspaceRoot,
                workspaceTrust: 'trusted',
                name: 'Durable trust demo',
                activeLeafId: 'entry_branch',
            }),
            'utf8',
        );

        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));
        const showOutput = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));

        expect(listOutput).toContain('trust=trusted');
        expect(showOutput.trustStatus).toBe('trusted');
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });
});
