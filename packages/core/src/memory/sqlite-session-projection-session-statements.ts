import type { InStatement } from '@libsql/client';
import type { SessionIndexSessionRecord } from './session-index-types.js';

export function insertSessionStatement(record: SessionIndexSessionRecord): InStatement {
    return {
        sql: `
            INSERT INTO sessions (
                session_id, status, created_at, updated_at, last_activity_at, stopped_at,
                last_event_seq, awaiting_reason, primary_wait_id, legacy_jsonl_path, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                last_activity_at = excluded.last_activity_at,
                stopped_at = excluded.stopped_at,
                last_event_seq = excluded.last_event_seq,
                awaiting_reason = excluded.awaiting_reason,
                primary_wait_id = excluded.primary_wait_id,
                legacy_jsonl_path = COALESCE(excluded.legacy_jsonl_path, sessions.legacy_jsonl_path),
                metadata_json = excluded.metadata_json
        `,
        args: [
            record.sessionId,
            record.status,
            record.startedAt,
            record.updatedAt,
            record.updatedAt,
            record.stoppedAt ?? null,
            record.lastSequence ?? 0,
            record.awaiting?.reason ?? null,
            primaryAwaitingSource(record)?.sourceId ?? null,
            record.sourceFilePath,
            JSON.stringify({
                eventCount: record.eventCount,
                lastEventId: record.lastEventId ?? null,
                lastEventType: record.lastEventType ?? null,
            }),
        ],
    };
}

export function insertAwaitingStatement(record: SessionIndexSessionRecord): InStatement | undefined {
    const awaiting = record.awaiting;
    if (awaiting === undefined) {
        return undefined;
    }
    const primarySource = primaryAwaitingSource(record);
    if (primarySource === undefined) {
        return undefined;
    }
    return {
        sql: `
            INSERT INTO session_awaits (
                wait_id, session_id, reason, source_kind, source_id, run_id, tool_call_id,
                approval_id, job_id, child_session_id, status, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(wait_id) DO UPDATE SET
                session_id = excluded.session_id,
                reason = excluded.reason,
                source_kind = excluded.source_kind,
                source_id = excluded.source_id,
                run_id = excluded.run_id,
                tool_call_id = excluded.tool_call_id,
                approval_id = excluded.approval_id,
                job_id = excluded.job_id,
                child_session_id = excluded.child_session_id,
                status = excluded.status,
                created_at = excluded.created_at,
                resolved_at = NULL,
                cancelled_at = NULL,
                metadata_json = excluded.metadata_json
        `,
        args: [
            primarySource.sourceId,
            record.sessionId,
            awaiting.reason,
            primarySource.sourceKind,
            primarySource.sourceId,
            awaiting.source.runId ?? null,
            awaiting.source.toolCallId ?? null,
            awaiting.source.approvalId ?? null,
            awaiting.source.jobId ?? null,
            awaiting.source.childSessionId ?? null,
            'pending',
            record.updatedAt,
            JSON.stringify({ owner: 'projection' }),
        ],
    };
}

function primaryAwaitingSource(
    record: SessionIndexSessionRecord,
):
    | { readonly sourceKind: 'approval' | 'run' | 'tool_call' | 'job' | 'child_session'; readonly sourceId: string }
    | undefined {
    const source = record.awaiting?.source;
    if (source === undefined) {
        return undefined;
    }
    if (source.approvalId !== undefined) {
        return { sourceKind: 'approval', sourceId: source.approvalId };
    }
    if (source.runId !== undefined) {
        return { sourceKind: 'run', sourceId: source.runId };
    }
    if (source.toolCallId !== undefined) {
        return { sourceKind: 'tool_call', sourceId: source.toolCallId };
    }
    if (source.jobId !== undefined) {
        return { sourceKind: 'job', sourceId: source.jobId };
    }
    if (source.childSessionId !== undefined) {
        return { sourceKind: 'child_session', sourceId: source.childSessionId };
    }
    return undefined;
}
