import { createFileSessionIndexStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    metadataEvent,
    pathExists,
    sessionIndexRecord,
    sessionLockPath,
    sessionLogPath,
    taskCompletedEvent,
    useTempDataDir,
    writeSessionLock,
} from './session-delete-test-support.js';
import { writeSessionEvents } from './session-test-support.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

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

        expect(output.trim()).toBe(`Deleted session ${sessionId} (1 events)`);
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

        const output = await runSessionCommand(parseArgs(['session', 'delete', parentId]));

        const deleted = output.trim().split('\n');
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

        const output = await runSessionCommand(parseArgs(['session', 'delete', childId]));

        expect(output.trim()).toBe(`Deleted session ${childId} (2 events)`);
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

    it('refuses to delete sessions with active live locks', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_live_locked';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'locked run')],
        });
        await writeSessionLock(dataDir, sessionId, '2099-01-01T00:00:00.000Z');

        await expect(runSessionCommand(parseArgs(['session', 'delete', sessionId]))).rejects.toMatchObject({
            code: 'session_live_locked',
        });
        expect(await pathExists(sessionLogPath(dataDir, sessionId))).toBe(true);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('--force overrides the live lock check', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_force_delete';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'locked run')],
        });
        await writeSessionLock(dataDir, sessionId, '2099-01-01T00:00:00.000Z');

        const output = await runSessionCommand(parseArgs(['session', 'delete', sessionId, '--force']));

        expect(output.trim()).toBe(`Deleted session ${sessionId} (1 events)`);
        expect(await pathExists(sessionLogPath(dataDir, sessionId))).toBe(false);
        expect(await pathExists(sessionLockPath(dataDir, sessionId))).toBe(false);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('deletes stale lock files alongside the session', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_stale_lock';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'stale run')],
        });
        await writeSessionLock(dataDir, sessionId, '2020-01-01T00:00:00.000Z');

        await runSessionCommand(parseArgs(['session', 'delete', sessionId]));

        expect(await pathExists(sessionLogPath(dataDir, sessionId))).toBe(false);
        expect(await pathExists(sessionLockPath(dataDir, sessionId))).toBe(false);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('removes session index entries after deletion', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_indexed';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [taskCompletedEvent(sessionId, 'indexed run')],
        });
        const indexPath = join(dataDir, 'session-index.json');
        const index = createFileSessionIndexStore({ indexPath });
        await index.replaceSessionIndex({
            sessionId,
            records: [sessionIndexRecord(dataDir, sessionId)],
            diagnostics: [],
        });
        expect(await index.getSession(sessionId)).not.toBeNull();

        await runSessionCommand(parseArgs(['session', 'delete', sessionId]));

        const after = createFileSessionIndexStore({ indexPath });
        expect(await after.getSession(sessionId)).toBeNull();
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
