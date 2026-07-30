import { sql } from 'drizzle-orm';
import type { MissionControlDrizzleDb } from '../db/drizzle-client';
import { sessionAwaits, sessions } from '../db/schema';
import type { SessionProjectionSessionRecord } from './session-projection-types';

export async function insertSessionRecord(
    db: MissionControlDrizzleDb,
    record: SessionProjectionSessionRecord,
): Promise<void> {
    await db
        .insert(sessions)
        .values({
            sessionId: record.sessionId,
            status: record.status,
            createdAt: record.startedAt,
            updatedAt: record.updatedAt,
            lastActivityAt: record.updatedAt,
            stoppedAt: record.stoppedAt ?? null,
            lastEventSeq: record.lastSequence ?? 0,
            awaitingReason: record.awaiting?.reason ?? null,
            primaryWaitId: primaryAwaitingSource(record)?.sourceId ?? null,
            workspacePath: record.cwd ?? null,
            parentSessionId: record.parentSessionId ?? null,
            legacyJsonlPath: record.sourcePath,
            metadataJson: JSON.stringify({
                eventCount: record.eventCount,
                lastEventId: record.lastEventId ?? null,
                lastEventType: record.lastEventType ?? null,
                ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
                ...(record.trustedRoot !== undefined ? { trustedRoot: record.trustedRoot } : {}),
                ...(record.workspaceTrust !== undefined ? { workspaceTrust: record.workspaceTrust } : {}),
                ...(record.name !== undefined ? { name: record.name } : {}),
                ...(record.messageCount !== undefined ? { messageCount: record.messageCount } : {}),
                ...(record.activeLeafId !== undefined ? { activeLeafId: record.activeLeafId } : {}),
                ...(record.abortMarker !== undefined
                    ? {
                          abortMarkerAt: record.abortMarker.completedAt,
                          abortOperationId: record.abortMarker.operationId,
                          abortRequestId: record.abortMarker.requestId,
                      }
                    : {}),
            }),
        })
        .onConflictDoUpdate({
            target: sessions.sessionId,
            set: {
                status: sql`excluded.status`,
                updatedAt: sql`excluded.updated_at`,
                lastActivityAt: sql`excluded.last_activity_at`,
                stoppedAt: sql`excluded.stopped_at`,
                lastEventSeq: sql`excluded.last_event_seq`,
                awaitingReason: sql`excluded.awaiting_reason`,
                primaryWaitId: sql`excluded.primary_wait_id`,
                workspacePath: sql`COALESCE(excluded.workspace_path, ${sessions.workspacePath})`,
                parentSessionId: sql`COALESCE(excluded.parent_session_id, ${sessions.parentSessionId})`,
                legacyJsonlPath: sql`COALESCE(excluded.legacy_jsonl_path, ${sessions.legacyJsonlPath})`,
                metadataJson: sql`excluded.metadata_json`,
            },
        });
}

export async function insertAwaitingRecord(
    db: MissionControlDrizzleDb,
    record: SessionProjectionSessionRecord,
): Promise<void> {
    const awaiting = record.awaiting;
    if (awaiting === undefined) return;
    const primarySource = primaryAwaitingSource(record);
    if (primarySource === undefined) return;
    await db
        .insert(sessionAwaits)
        .values({
            waitId: primarySource.sourceId,
            sessionId: record.sessionId,
            reason: awaiting.reason,
            sourceKind: primarySource.sourceKind,
            sourceId: primarySource.sourceId,
            runId: awaiting.source.runId ?? null,
            toolCallId: awaiting.source.toolCallId ?? null,
            approvalId: awaiting.source.approvalId ?? null,
            jobId: awaiting.source.jobId ?? null,
            childSessionId: awaiting.source.childSessionId ?? null,
            status: 'pending',
            createdAt: record.updatedAt,
            metadataJson: JSON.stringify({ owner: 'projection' }),
        })
        .onConflictDoUpdate({
            target: sessionAwaits.waitId,
            set: {
                sessionId: sql`excluded.session_id`,
                reason: sql`excluded.reason`,
                sourceKind: sql`excluded.source_kind`,
                sourceId: sql`excluded.source_id`,
                runId: sql`excluded.run_id`,
                toolCallId: sql`excluded.tool_call_id`,
                approvalId: sql`excluded.approval_id`,
                jobId: sql`excluded.job_id`,
                childSessionId: sql`excluded.child_session_id`,
                status: sql`excluded.status`,
                createdAt: sql`excluded.created_at`,
                resolvedAt: null,
                cancelledAt: null,
                metadataJson: sql`excluded.metadata_json`,
            },
        });
}

function primaryAwaitingSource(
    record: SessionProjectionSessionRecord,
):
    | { readonly sourceKind: 'approval' | 'run' | 'tool_call' | 'job' | 'child_session'; readonly sourceId: string }
    | undefined {
    const source = record.awaiting?.source;
    if (source === undefined) return undefined;
    if (source.approvalId !== undefined) return { sourceKind: 'approval', sourceId: source.approvalId };
    if (source.runId !== undefined) return { sourceKind: 'run', sourceId: source.runId };
    if (source.toolCallId !== undefined) return { sourceKind: 'tool_call', sourceId: source.toolCallId };
    if (source.jobId !== undefined) return { sourceKind: 'job', sourceId: source.jobId };
    if (source.childSessionId !== undefined) return { sourceKind: 'child_session', sourceId: source.childSessionId };
    return undefined;
}
