import type { IndexColumn } from 'drizzle-orm/sqlite-core';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
    approvals,
    asyncJobs,
    contextEpochs,
    memoryEntries,
    missionRuns,
    missions,
    providerFailures,
    runtimeAgents,
    sessionAwaits,
    sessionControlLeases,
    sessionEventSequences,
    sessionEvents,
    sessionInputs,
    sessionLifecycleStatuses,
    sessionMessages,
    sessionParts,
    sessionRelations,
    sessions,
    toolCalls,
} from './schema';

const columnNamesFor = (table: Parameters<typeof getTableConfig>[0]): readonly string[] =>
    getTableConfig(table).columns.map((column) => column.name);

const indexColumnsByName = (table: Parameters<typeof getTableConfig>[0], indexName: string): readonly string[] => {
    const matchingIndex = getTableConfig(table).indexes.find((index) => index.config.name === indexName);

    return matchingIndex?.config.columns.flatMap((column) => indexColumnName(column)) ?? [];
};

const indexColumnName = (column: IndexColumn): readonly string[] => {
    if ('name' in column) {
        return [column.name];
    }

    return [];
};

describe('database schema exports', () => {
    it('characterizes the existing persistent memory table before session tables are added', () => {
        // Given: the current Drizzle schema module.
        const memoryTable = getTableConfig(memoryEntries);

        // When: callers inspect the exported table metadata.
        const columnNames = memoryTable.columns.map((column) => column.name);

        // Then: the existing memory table contract is still present.
        expect(memoryTable.name).toBe('memory_entries');
        expect(columnNames).toEqual(['namespace', 'key', 'value', 'created_at', 'expires_at']);
    });

    it('models the required session storage tables', () => {
        // Given: the Drizzle schema exports for the local session database.
        const tables = [
            sessionEventSequences,
            sessionEvents,
            sessions,
            sessionControlLeases,
            sessionAwaits,
            sessionInputs,
            sessionMessages,
            sessionParts,
            sessionRelations,
            missions,
            missionRuns,
            approvals,
            toolCalls,
            providerFailures,
            contextEpochs,
            runtimeAgents,
            asyncJobs,
        ];

        // When: table names are read from Drizzle metadata.
        const tableNames = tables.map((table) => getTableConfig(table).name);

        // Then: every planned session table has a concrete schema definition.
        expect(tableNames).toEqual([
            'session_event_sequences',
            'session_events',
            'sessions',
            'session_control_leases',
            'session_awaits',
            'session_inputs',
            'session_messages',
            'session_parts',
            'session_relations',
            'missions',
            'mission_runs',
            'approvals',
            'tool_calls',
            'provider_failures',
            'context_epochs',
            'runtime_agents',
            'async_jobs',
        ]);
    });

    it('defines required key indexes and uniqueness constraints', () => {
        // Given: Drizzle metadata for append-only events and query projections.
        const eventConfig = getTableConfig(sessionEvents);
        const waitConfig = getTableConfig(sessionAwaits);
        const relationConfig = getTableConfig(sessionRelations);
        const jobConfig = getTableConfig(asyncJobs);
        const sessionConfig = getTableConfig(sessions);

        // When: index and constraint names are projected from the metadata.
        const eventPrimaryKeyColumns = eventConfig.primaryKeys.map((key) => key.columns.map((column) => column.name));
        const eventUniqueNames = eventConfig.uniqueConstraints.map((constraint) => constraint.name);
        const waitIndexes = waitConfig.indexes.map((index) => index.config.name);
        const relationIndexes = relationConfig.indexes.map((index) => index.config.name);
        const jobIndexes = jobConfig.indexes.map((index) => index.config.name);
        const sessionIndexes = sessionConfig.indexes.map((index) => index.config.name);

        // Then: replay, wait, child lookup, job lookup, and status listing paths are indexed.
        expect(eventPrimaryKeyColumns).toContainEqual(['session_id', 'seq']);
        expect(eventUniqueNames).toContain('session_events_event_id_unique');
        expect(waitIndexes).toContain('session_awaits_pending_idx');
        expect(relationIndexes).toContain('session_relations_child_session_idx');
        expect(jobIndexes).toContain('async_jobs_status_idx');
        expect(sessionIndexes).toContain('sessions_status_listing_idx');
    });

    it('defines foreign-key-compatible columns for session projections', () => {
        // Given: the session projection tables that later runtime tasks will populate.
        const eventColumns = columnNamesFor(sessionEvents);
        const waitColumns = columnNamesFor(sessionAwaits);
        const relationColumns = columnNamesFor(sessionRelations);
        const jobColumns = columnNamesFor(asyncJobs);

        // When: required lookup columns are read from Drizzle metadata.
        const sessionStatusIndexColumns = indexColumnsByName(sessions, 'sessions_status_listing_idx');
        const pendingWaitIndexColumns = indexColumnsByName(sessionAwaits, 'session_awaits_pending_idx');
        const childRelationIndexColumns = indexColumnsByName(sessionRelations, 'session_relations_child_session_idx');
        const jobStatusIndexColumns = indexColumnsByName(asyncJobs, 'async_jobs_status_idx');

        // Then: append, await, child lookup, and job lookup schemas expose stable key columns.
        expect(eventColumns).toEqual(
            expect.arrayContaining(['session_id', 'seq', 'event_id', 'run_id', 'turn_id', 'payload_json']),
        );
        expect(waitColumns).toEqual(
            expect.arrayContaining([
                'session_id',
                'reason',
                'source_kind',
                'source_id',
                'approval_id',
                'job_id',
                'child_session_id',
                'status',
            ]),
        );
        expect(relationColumns).toEqual(expect.arrayContaining(['parent_session_id', 'child_session_id', 'kind']));
        expect(jobColumns).toEqual(expect.arrayContaining(['parent_session_id', 'child_session_id', 'status']));
        expect(sessionStatusIndexColumns).toEqual(['status', 'last_activity_at']);
        expect(pendingWaitIndexColumns).toEqual(['session_id', 'reason', 'created_at']);
        expect(childRelationIndexColumns).toEqual(['child_session_id']);
        expect(jobStatusIndexColumns).toEqual(['status', 'queued_at']);
    });

    it('keeps lifecycle literals narrow enough to reject malformed status values', () => {
        // Given: the lifecycle values exposed beside the schema.
        const validStatuses: readonly string[] = sessionLifecycleStatuses;

        // When: a malformed lifecycle literal is probed.
        const acceptsMalformedStatus = validStatuses.includes('waiting');

        // Then: the schema vocabulary uses awaiting, not an untracked synonym.
        expect(validStatuses).toContain('awaiting');
        expect(acceptsMalformedStatus).toBe(false);
    });
});
