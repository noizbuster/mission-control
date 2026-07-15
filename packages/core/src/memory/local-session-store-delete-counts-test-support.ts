import { z } from 'zod';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import { localSessionDbUrl } from './local-session-store';

export type SessionReferenceCounts = {
    readonly sessions: number;
    readonly desktopToolProposals: number;
    readonly desktopApprovalEffects: number;
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

export async function sessionReferenceCounts(dataDir: string, sessionId: string): Promise<SessionReferenceCounts> {
    const runtime = await openLocalLibsqlDb({ url: localSessionDbUrl(dataDir) });
    try {
        return {
            sessions: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?',
                sessionId,
            ),
            desktopToolProposals: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM desktop_tool_proposals WHERE session_id = ?',
                sessionId,
            ),
            desktopApprovalEffects: await countRows(
                runtime.client,
                'SELECT COUNT(*) AS count FROM desktop_approval_effects WHERE session_id = ?',
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
