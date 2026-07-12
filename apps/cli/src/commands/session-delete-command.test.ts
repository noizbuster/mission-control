import {
    closeProcessSessionControlHosts,
    computeCanonicalSessionTreeToken,
    getProcessSessionControlHost,
} from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    metadataEvent,
    pathExists,
    sessionLogPath,
    setCanonicalSessionParent,
    taskCompletedEvent,
    useTempDataDir,
} from './session-delete-test-support.js';
import { readStoredSessionProjection, writeSessionEvents } from './session-test-support.js';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';

describe('guarded session delete command', () => {
    afterEach(async () => {
        await closeProcessSessionControlHosts();
        vi.unstubAllEnvs();
    });

    it('routes canonical parent test setup through the product write lane', () => {
        const source = readFileSync(new URL('./session-delete-test-support.ts', import.meta.url), 'utf8');

        expect(source).toContain('runLocalLibsqlWrite(runtime');
        expect(source).not.toContain('await runtime.client.batch(');
    });

    it('parses only a lowercase SHA-256 expected tree token and retains tokenless delete', () => {
        // Given
        const token = 'a'.repeat(64);

        // When
        const guarded = parseArgs(['session', 'delete', 'session_root', '--expected-tree-token', token]);
        const tokenless = parseArgs(['session', 'delete', 'session_root']);

        // Then
        expect(guarded).toMatchObject({ command: 'session-delete', expectedTreeToken: token });
        expect(tokenless.expectedTreeToken).toBeUndefined();
        for (const invalid of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '--force']) {
            expect(() => parseArgs(['session', 'delete', 'session_root', invalid])).toThrow();
        }
    });

    it('accepts the canonical token and deletes the complete canonical subtree', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const rootId = 'session_guarded_root';
        const childId = 'session_guarded_child';
        await writeTree(dataDir, rootId, childId);
        const token = computeCanonicalSessionTreeToken([
            { sessionId: rootId, parentSessionId: null, depth: 0 },
            { sessionId: childId, parentSessionId: rootId, depth: 1 },
        ]);

        // When
        const result = await runSessionCommand(
            parseArgs(['session', 'delete', rootId, '--expected-tree-token', token]),
        );

        // Then
        expect(result).toMatchObject({ exitCode: 0, stderr: '' });
        expect(result.stdout.split('\n')).toEqual([
            `Deleted session ${rootId} (1 events)`,
            `Deleted session ${childId} (2 events)`,
        ]);
        expect(await pathExists(sessionLogPath(dataDir, rootId))).toBe(false);
        expect(await pathExists(sessionLogPath(dataDir, childId))).toBe(false);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('rejects a stale token after descendant insertion without deleting any subtree row', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const rootId = 'session_changed_root';
        const childId = 'session_changed_child';
        const lateId = 'session_changed_late';
        await writeTree(dataDir, rootId, childId);
        const staleToken = computeCanonicalSessionTreeToken([
            { sessionId: rootId, parentSessionId: null, depth: 0 },
            { sessionId: childId, parentSessionId: rootId, depth: 1 },
        ]);
        await writeSessionEvents({
            dataDir,
            sessionId: lateId,
            events: [metadataEvent(lateId, childId), taskCompletedEvent(lateId, 'late run')],
        });
        await readStoredSessionProjection({ dataDir, sessionId: lateId });
        await setCanonicalSessionParent(dataDir, lateId, childId);

        // When
        const deletion = runSessionCommand(
            parseArgs(['session', 'delete', rootId, '--expected-tree-token', staleToken]),
        );

        // Then
        await expect(deletion).rejects.toMatchObject({ code: 'session_tree_changed' });
        for (const sessionId of [rootId, childId, lateId]) {
            expect(await pathExists(sessionLogPath(dataDir, sessionId))).toBe(true);
        }
        await rm(dataDir, { recursive: true, force: true });
    });

    it('rejects an unexpired subtree lease before deletion and does not force fallback', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const rootId = 'session_live_root';
        const childId = 'session_live_child';
        await writeTree(dataDir, rootId, childId);
        await insertLiveLease(dataDir, childId);

        // When
        const deletion = runSessionCommand(parseArgs(['session', 'delete', rootId]));

        // Then
        await expect(deletion).rejects.toMatchObject({ code: 'session_live_locked' });
        expect(await pathExists(sessionLogPath(dataDir, rootId))).toBe(true);
        expect(await pathExists(sessionLogPath(dataDir, childId))).toBe(true);
        expect(() => parseArgs(['session', 'delete', rootId, '--force'])).toThrow();
        await closeProcessSessionControlHosts();
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function writeTree(dataDir: string, rootId: string, childId: string): Promise<void> {
    await writeSessionEvents({ dataDir, sessionId: rootId, events: [taskCompletedEvent(rootId, 'root run')] });
    await writeSessionEvents({
        dataDir,
        sessionId: childId,
        events: [metadataEvent(childId, rootId), taskCompletedEvent(childId, 'child run')],
    });
    await readStoredSessionProjection({ dataDir, sessionId: rootId });
    await readStoredSessionProjection({ dataDir, sessionId: childId });
    await setCanonicalSessionParent(dataDir, childId, rootId);
}

async function insertLiveLease(dataDir: string, sessionId: string): Promise<void> {
    const host = await getProcessSessionControlHost(dataDir);
    await host.acquire(sessionId);
}
