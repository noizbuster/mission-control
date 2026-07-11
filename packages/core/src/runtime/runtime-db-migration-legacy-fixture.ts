import type { InStatement, InValue } from '@libsql/client';
import { type Run, RunSchema } from '@mission-control/protocol';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { envelope, runEvent } from '../session-replay-coding-test-support.js';
import { sessionStoreDatabasePath } from './session-store-identity.js';
import { pathToFileURL } from 'node:url';

export async function seedCompleteLegacyDatabase(legacyRoot: string): Promise<Run> {
    const databasePath = sessionStoreDatabasePath(legacyRoot);
    const runtime = await openLocalLibsqlDb({ url: pathToFileURL(databasePath).href });
    const run = RunSchema.parse({
        id: 'legacy_run',
        missionId: 'legacy_mission',
        sessionId: 'legacy_session',
        status: 'running',
        startedAt: '2026-07-01T00:00:00.000Z',
    });
    const event = envelope(
        runEvent('legacy_session', 'run.started', 'legacy run started', {
            runId: run.id,
            command: 'wake',
            state: 'running',
        }),
        0,
        'legacy_event',
    );
    try {
        await runtime.client.batch(
            [
                statement(
                    'INSERT INTO sessions (session_id, root_session_id, parent_session_id, status, awaiting_reason, primary_wait_id, workspace_path, provider_id, model_id, title, total_input_tokens, total_output_tokens, total_cost_usd, last_event_seq, created_at, updated_at, last_activity_at, stopped_at, failed_at, legacy_jsonl_path, imported_at, exported_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_session',
                        null,
                        null,
                        'running',
                        null,
                        null,
                        '/workspace',
                        'local',
                        'echo',
                        'Legacy',
                        1,
                        2,
                        '0.1',
                        0,
                        event.createdAt,
                        event.createdAt,
                        event.createdAt,
                        null,
                        null,
                        null,
                        null,
                        null,
                        '{}',
                    ],
                ),
                statement(
                    'INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?)',
                    ['legacy_child', 'idle', event.createdAt, event.createdAt, event.createdAt],
                ),
                statement(
                    'INSERT INTO missions (mission_id, status, workflow_name, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_mission',
                        'active',
                        'legacy',
                        event.createdAt,
                        event.createdAt,
                        JSON.stringify({ id: 'legacy_mission' }),
                    ],
                ),
                statement('INSERT INTO session_event_sequences (session_id, next_seq, updated_at) VALUES (?, ?, ?)', [
                    'legacy_session',
                    1,
                    event.createdAt,
                ]),
                statement(
                    'INSERT INTO session_events (session_id, seq, event_id, type, timestamp, run_id, turn_id, causation_id, correlation_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_session',
                        0,
                        event.eventId,
                        event.event.type,
                        event.event.timestamp,
                        run.id,
                        null,
                        null,
                        null,
                        JSON.stringify(event),
                    ],
                ),
                statement(
                    'INSERT INTO mission_runs (run_id, mission_id, parent_run_id, session_id, child_agent_kind, child_agent_id, child_session_ids_json, retry_state_json, status, prompt, created_at, updated_at, started_at, ended_at, completed_at, failed_at, cancelled_at, passthrough_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        run.id,
                        run.missionId,
                        null,
                        run.sessionId ?? null,
                        null,
                        null,
                        '[]',
                        '{}',
                        run.status,
                        null,
                        run.startedAt ?? event.createdAt,
                        event.createdAt,
                        run.startedAt ?? null,
                        null,
                        null,
                        null,
                        null,
                        JSON.stringify(run),
                    ],
                ),
                statement(
                    'INSERT INTO session_inputs (input_id, session_id, delivery, status, prompt, admitted_seq, promoted_seq, created_at, admitted_at, promoted_at, cancelled_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_input',
                        'legacy_session',
                        'queue',
                        'admitted',
                        'continue',
                        0,
                        null,
                        event.createdAt,
                        event.createdAt,
                        null,
                        null,
                        '{}',
                    ],
                ),
                statement(
                    'INSERT INTO session_awaits (wait_id, session_id, reason, source_kind, source_id, run_id, tool_call_id, approval_id, job_id, child_session_id, status, created_at, resolved_at, cancelled_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_wait',
                        'legacy_session',
                        'subagent',
                        'job',
                        'legacy_job',
                        run.id,
                        null,
                        null,
                        'legacy_job',
                        'legacy_child',
                        'pending',
                        event.createdAt,
                        null,
                        null,
                        '{}',
                    ],
                ),
                statement(
                    'INSERT INTO context_epochs (context_epoch_id, session_id, epoch, source_id, baseline_text, update_text, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['legacy_epoch', 'legacy_session', 1, 'source', 'base', 'update', event.createdAt, '{}'],
                ),
                statement(
                    'INSERT INTO session_relations (relation_id, parent_session_id, child_session_id, kind, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
                    ['legacy_relation', 'legacy_session', 'legacy_child', 'subagent', event.createdAt, '{}'],
                ),
                statement(
                    'INSERT INTO runtime_agents (agent_id, kind, session_id, parent_agent_id, status, activity, visibility, created_at, updated_at, parked_at, revived_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_agent',
                        'sub',
                        'legacy_child',
                        null,
                        'running',
                        'working',
                        'visible',
                        event.createdAt,
                        event.createdAt,
                        null,
                        null,
                        '{}',
                    ],
                ),
                statement(
                    'INSERT INTO async_jobs (job_id, parent_session_id, child_session_id, agent_id, status, queued_at, started_at, completed_at, failed_at, cancelled_at, cancellation_reason, result_json, error_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'legacy_job',
                        'legacy_session',
                        'legacy_child',
                        'legacy_agent',
                        'running',
                        event.createdAt,
                        event.createdAt,
                        null,
                        null,
                        null,
                        null,
                        null,
                        null,
                        '{}',
                    ],
                ),
                statement(
                    'INSERT INTO legacy_session_imports (import_id, source_path, source_kind, checksum, imported_event_count, imported_at, diagnostics_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    ['legacy_import', '/legacy/session.jsonl', 'jsonl', 'abc', 1, event.createdAt, '[]'],
                ),
                statement(
                    'INSERT INTO memory_entries (namespace, key, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                    ['legacy', 'key', 'value', event.createdAt, null],
                ),
                statement(
                    'INSERT INTO session_projection_diagnostics (session_id, file_path, code, message, line_number) VALUES (?, ?, ?, ?, ?)',
                    ['legacy_session', '/legacy/not-authoritative', 'must_not_copy', 'projection rows are rebuilt', 1],
                ),
            ],
            'write',
        );
    } finally {
        runtime.close();
    }
    return run;
}

function statement(sql: string, args: readonly InValue[]): InStatement {
    return { sql, args: [...args] };
}
