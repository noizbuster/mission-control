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
import { rm } from 'node:fs/promises';

describe('session delete', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('deletes a single session with no children', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_solo';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'solo run')],
        });
        expect(await pathExists(sessionLogPath(dataDir, sessionId))).toBe(true);

        const output = await runSessionCommand(parseArgs(['session', 'delete', sessionId]));

        expect(output.stdout).toBe(`Deleted session ${sessionId} (1 events)`);
        expect(await pathExists(sessionLogPath(dataDir, sessionId))).toBe(false);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('deletes a parent and all descendant sessions recursively', async () => {
        const dataDir = await useTempDataDir();
        const parentId = 'session_parent_root';
        const childId = 'session_parent_root_child_1';
        const grandchildId = 'session_parent_root_child_1_child_1';
        await writeSessionEvents({
            dataDir,
            sessionId: parentId,
            events: [taskCompletedEvent(parentId, 'parent run')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: childId,
            events: [metadataEvent(childId, parentId), taskCompletedEvent(childId, 'child run')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: grandchildId,
            events: [metadataEvent(grandchildId, childId), taskCompletedEvent(grandchildId, 'grandchild run')],
        });
        await readStoredSessionProjection({ dataDir, sessionId: parentId });
        await readStoredSessionProjection({ dataDir, sessionId: childId });
        await readStoredSessionProjection({ dataDir, sessionId: grandchildId });
        await setCanonicalSessionParent(dataDir, childId, parentId);
        await setCanonicalSessionParent(dataDir, grandchildId, childId);

        const output = await runSessionCommand(parseArgs(['session', 'delete', parentId]));

        const deleted = output.stdout.split('\n');
        expect(deleted).toContain(`Deleted session ${parentId} (1 events)`);
        expect(deleted).toContain(`Deleted session ${childId} (2 events)`);
        expect(deleted).toContain(`Deleted session ${grandchildId} (2 events)`);
        expect(await pathExists(sessionLogPath(dataDir, parentId))).toBe(false);
        expect(await pathExists(sessionLogPath(dataDir, childId))).toBe(false);
        expect(await pathExists(sessionLogPath(dataDir, grandchildId))).toBe(false);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('deletes a child tree without touching unrelated sessions', async () => {
        const dataDir = await useTempDataDir();
        const parentId = 'session_tree_root';
        const childId = 'session_tree_root_child_1';
        const unrelatedId = 'session_unrelated';
        await writeSessionEvents({
            dataDir,
            sessionId: parentId,
            events: [taskCompletedEvent(parentId, 'parent run')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: childId,
            events: [metadataEvent(childId, parentId), taskCompletedEvent(childId, 'child run')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: unrelatedId,
            events: [taskCompletedEvent(unrelatedId, 'unrelated run')],
        });
        await readStoredSessionProjection({ dataDir, sessionId: parentId });
        await readStoredSessionProjection({ dataDir, sessionId: childId });
        await setCanonicalSessionParent(dataDir, childId, parentId);

        const output = await runSessionCommand(parseArgs(['session', 'delete', childId]));

        expect(output.stdout).toBe(`Deleted session ${childId} (2 events)`);
        expect(await pathExists(sessionLogPath(dataDir, childId))).toBe(false);
        expect(await pathExists(sessionLogPath(dataDir, parentId))).toBe(true);
        expect(await pathExists(sessionLogPath(dataDir, unrelatedId))).toBe(true);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('throws typed error for invalid session id', async () => {
        const dataDir = await useTempDataDir();
        await expect(runSessionCommand(parseArgs(['session', 'delete', '../bad']))).rejects.toMatchObject({
            code: 'invalid_session_id',
        });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('throws typed error when session is not found', async () => {
        const dataDir = await useTempDataDir();
        await expect(runSessionCommand(parseArgs(['session', 'delete', 'session_nonexistent']))).rejects.toMatchObject({
            code: 'session_not_found',
        });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('rejects unsupported arguments after session id', () => {
        expect(() => parseArgs(['session', 'delete', 'session_x', '--bogus'])).toThrow(
            'Unsupported session delete argument: --bogus',
        );
    });

    it('requires a session id', () => {
        expect(() => parseArgs(['session', 'delete'])).toThrow('session delete requires a session id');
    });
});
