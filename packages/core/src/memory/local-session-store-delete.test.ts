import { describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import {
    deleteLocalSessionRows,
    localSessionDbUrl,
    openLocalSessionEventStore,
    readLocalSessionReplay,
} from './local-session-store.js';
import { seedSessionScopedSqlRows, sessionReferenceCounts } from './local-session-store-delete-test-support.js';
import { CREATED_AT, sessionStartedEvent, tempDataDir, UPDATED_AT } from './local-session-store-test-support.js';

describe('local session store delete cleanup', () => {
    it('deletes SQLite-native session-scoped rows before the same session id is recreated', async () => {
        // Given: a native SQLite session has pending runtime rows and session references.
        const dataDir = await tempDataDir('delete-sql-cleanup');
        const sessionId = 'session_sqlite_delete_cleanup';
        const childSessionId = 'session_sqlite_delete_cleanup_child';
        const otherSessionId = 'session_sqlite_delete_cleanup_other';
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => CREATED_AT,
            createEventId: (_event, sequence) => `event_delete_cleanup_${sequence}`,
        });
        await store.append(sessionStartedEvent(sessionId));
        await store.close();
        await seedSessionScopedSqlRows({ dataDir, sessionId, childSessionId, otherSessionId });
        const guardRuntime = await openLocalLibsqlDb({ url: localSessionDbUrl(dataDir) });
        await guardRuntime.client.execute(`
            CREATE TRIGGER require_desktop_effect_cleanup_before_session_delete
            BEFORE DELETE ON sessions
            WHEN EXISTS (SELECT 1 FROM desktop_approval_effects WHERE session_id = OLD.session_id)
            BEGIN
                SELECT RAISE(ABORT, 'desktop approval effects must be deleted first');
            END
        `);
        guardRuntime.close();

        // When: the production local session delete path removes the original id.
        await deleteLocalSessionRows({ dataDir, sessionIds: [sessionId] });

        // Then: no stale rows or session references can attach to a recreated id.
        await expect(sessionReferenceCounts(dataDir, sessionId)).resolves.toEqual({
            sessions: 0,
            desktopToolProposals: 0,
            desktopApprovalEffects: 0,
            sessionInputs: 0,
            sessionAwaits: 0,
            sessionAwaitsChild: 0,
            contextEpochs: 0,
            sessionRelationsParent: 0,
            sessionRelationsChild: 0,
            missionRuns: 0,
            runtimeAgents: 0,
            asyncJobsParent: 0,
            asyncJobsChild: 0,
        });

        const recreatedStore = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => UPDATED_AT,
            createEventId: (_event, sequence) => `event_recreated_cleanup_${sequence}`,
        });
        await recreatedStore.append(sessionStartedEvent(sessionId));
        await recreatedStore.close();
        const replay = await readLocalSessionReplay({ dataDir, sessionId });

        expect(replay.kind).toBe('found');
        expect(replay.kind === 'found' ? replay.replay.projection.envelopes.map((item) => item.eventId) : []).toEqual([
            'event_recreated_cleanup_0',
        ]);
        await expect(sessionReferenceCounts(dataDir, sessionId)).resolves.toMatchObject({
            desktopToolProposals: 0,
            desktopApprovalEffects: 0,
            sessionInputs: 0,
            sessionAwaits: 0,
            sessionAwaitsChild: 0,
            contextEpochs: 0,
            sessionRelationsParent: 0,
            sessionRelationsChild: 0,
            missionRuns: 0,
            runtimeAgents: 0,
            asyncJobsParent: 0,
            asyncJobsChild: 0,
        });
    });
});
