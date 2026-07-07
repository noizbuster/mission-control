import { z } from 'zod';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { localSessionDbUrl } from './local-session-store.js';
import { CREATED_AT } from './local-session-store-test-support.js';

type SessionScopedRowsInput = {
    readonly dataDir: string;
    readonly sessionId: string;
    readonly childSessionId: string;
    readonly otherSessionId: string;
};

export type SessionReferenceCounts = {
    readonly sessions: number;
    readonly sessionInputs: number;
    readonly sessionAwaits: number;
    readonly sessionAwaitsChild: number;
    readonly contextEpochs: number;
    readonly sessionRelationsParent: number;
    readonly sessionRelationsChild: number;
    readonly missionRuns: number;
    readonly runtimeAgents: number;
    readonly asyncJobsParent: number;
    readonly asyncJobsChild: number;
};

const CountRowSchema = z.object({ count: z.number() });

export async function seedSessionScopedSqlRows(input: SessionScopedRowsInput): Promise<void> {
    const runtime = await openLocalLibsqlDb({ url: localSessionDbUrl(input.dataDir) });
    try {
        await runtime.client.batch(
            [
                {
                    sql:
                        'INSERT INTO sessions (session_id, parent_session_id, status, created_at, updated_at, last_activity_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
                    args: [
                        input.otherSessionId,
                        null,
                        'idle',
                        CREATED_AT,
                        CREATED_AT,
                        CREATED_AT,
                        input.childSessionId,
                        input.sessionId,
                        'idle',
                        CREATED_AT,
                        CREATED_AT,
                        CREATED_AT,
                    ],
                },
                {
                    sql:
                        'INSERT INTO session_inputs (input_id, session_id, delivery, status, prompt, admitted_seq, created_at, admitted_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'input_delete_cleanup',
                        input.sessionId,
                        'queue',
                        'admitted',
                        'continue',
                        0,
                        CREATED_AT,
                        CREATED_AT,
                    ],
                },
                {
                    sql:
                        'INSERT INTO session_awaits (wait_id, session_id, reason, source_kind, source_id, child_session_id, status, created_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'wait_delete_cleanup',
                        input.sessionId,
                        'user_input',
                        'operator',
                        'input_delete_cleanup',
                        null,
                        'pending',
                        CREATED_AT,
                        'wait_delete_cleanup_child',
                        input.otherSessionId,
                        'subagent',
                        'job',
                        'job_delete_cleanup',
                        input.sessionId,
                        'pending',
                        CREATED_AT,
                    ],
                },
                {
                    sql:
                        'INSERT INTO context_epochs (context_epoch_id, session_id, epoch, source_id, baseline_text, update_text, created_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'epoch_delete_cleanup',
                        input.sessionId,
                        1,
                        'source_delete_cleanup',
                        'old baseline',
                        'old update',
                        CREATED_AT,
                    ],
                },
                {
                    sql:
                        'INSERT INTO missions (mission_id, status, created_at, updated_at, payload_json) ' +
                        'VALUES (?, ?, ?, ?, ?)',
                    args: ['mission_delete_cleanup', 'running', CREATED_AT, CREATED_AT, '{}'],
                },
                {
                    sql:
                        'INSERT INTO mission_runs (run_id, mission_id, session_id, status, created_at, updated_at, passthrough_json) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'run_delete_cleanup',
                        'mission_delete_cleanup',
                        input.sessionId,
                        'running',
                        CREATED_AT,
                        CREATED_AT,
                        '{}',
                    ],
                },
                {
                    sql:
                        'INSERT INTO session_relations (relation_id, parent_session_id, child_session_id, kind, created_at) ' +
                        'VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
                    args: [
                        'relation_delete_cleanup_parent',
                        input.sessionId,
                        input.otherSessionId,
                        'delegated',
                        CREATED_AT,
                        'relation_delete_cleanup_child',
                        input.otherSessionId,
                        input.sessionId,
                        'delegated',
                        CREATED_AT,
                    ],
                },
                {
                    sql:
                        'INSERT INTO runtime_agents (agent_id, kind, session_id, status, created_at, updated_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?)',
                    args: ['agent_delete_cleanup', 'agent', input.sessionId, 'idle', CREATED_AT, CREATED_AT],
                },
                {
                    sql:
                        'INSERT INTO async_jobs (job_id, parent_session_id, child_session_id, status, queued_at) ' +
                        'VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
                    args: [
                        'job_delete_cleanup_parent',
                        input.sessionId,
                        input.otherSessionId,
                        'running',
                        CREATED_AT,
                        'job_delete_cleanup_child',
                        input.otherSessionId,
                        input.sessionId,
                        'running',
                        CREATED_AT,
                    ],
                },
            ],
            'write',
        );
    } finally {
        runtime.close();
    }
}

export async function sessionReferenceCounts(dataDir: string, sessionId: string): Promise<SessionReferenceCounts> {
    const runtime = await openLocalLibsqlDb({ url: localSessionDbUrl(dataDir) });
    try {
        return {
            sessions: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?',
                sessionId,
            ),
            sessionInputs: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM session_inputs WHERE session_id = ?',
                sessionId,
            ),
            sessionAwaits: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM session_awaits WHERE session_id = ?',
                sessionId,
            ),
            sessionAwaitsChild: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM session_awaits WHERE child_session_id = ?',
                sessionId,
            ),
            contextEpochs: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM context_epochs WHERE session_id = ?',
                sessionId,
            ),
            sessionRelationsParent: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM session_relations WHERE parent_session_id = ?',
                sessionId,
            ),
            sessionRelationsChild: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM session_relations WHERE child_session_id = ?',
                sessionId,
            ),
            missionRuns: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM mission_runs WHERE session_id = ?',
                sessionId,
            ),
            runtimeAgents: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM runtime_agents WHERE session_id = ?',
                sessionId,
            ),
            asyncJobsParent: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM async_jobs WHERE parent_session_id = ?',
                sessionId,
            ),
            asyncJobsChild: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM async_jobs WHERE child_session_id = ?',
                sessionId,
            ),
        };
    } finally {
        runtime.close();
    }
}

async function countRows(
    client: Awaited<ReturnType<typeof openLocalLibsqlDb>>['client'],
    sql: string,
    sessionId: string,
): Promise<number> {
    const result = await client.execute({ sql, args: [sessionId] });
    return CountRowSchema.parse(result.rows[0]).count;
}
