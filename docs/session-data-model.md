# Session Data Model

Mission Control uses one shared local libSQL surface for durable sessions:

- `<MCTRL_DATA_DIR>/memory.db` is the authoritative session event/replay
  database. New coding-agent session appends write `session_events` there, replay
  and session-list projections are derived from those events, production
  `user_input` and foreground `subagent` waits are mirrored there, and legacy
  JSONL import/export compatibility uses this database. Runtime coordination SQL
  for session inputs, Mission/Run records, context epochs, runtime agents,
  async jobs, and relation rows uses the same local-only data-dir `memory.db`
  file.

Remote Turso is out of scope: the local DB opener accepts `:memory:` and `file:`
URLs only, rejects `libsql://` and other remote schemes, and does not read auth
tokens or configure sync.

Legacy JSONL session logs are still supported as an import/export compatibility
window. They are not deleted during import, and explicit export can write a
SQLite-native session back to JSONL/archive form for rollback or older readers.

## Contents

- [Authoritative Tables](#authoritative-tables)
- [Key Indexes](#key-indexes)
- [Event And Projection Contract](#event-and-projection-contract)
- [Session State Machine](#session-state-machine)
- [Awaiting Semantics](#awaiting-semantics)
- [Subagent Lineage And Jobs](#subagent-lineage-and-jobs)
- [Legacy Import And Export](#legacy-import-and-export)
- [Local Path And Memory Relationship](#local-path-and-memory-relationship)
- [Rollback And Operations](#rollback-and-operations)

## Authoritative Tables

Core `<MCTRL_DATA_DIR>/memory.db` tables:

| Table | Responsibility |
| --- | --- |
| `memory_entries` | Existing persistent working-memory key/value table. It shares `memory.db` and is not a session replay table. |
| `sessions` | Current session projection and listing row. Stores lifecycle status, optional `awaiting_reason`, `primary_wait_id`, parent/root ids, workspace/provider/model/title metadata, token/cost summaries, last event sequence, activity timestamps, legacy JSONL path, import/export timestamps, and `metadata_json`. |
| `session_event_sequences` | Per-session sequence allocator. The event store updates `next_seq` transactionally with append writes so replay order is stable per session. |
| `session_events` | Append-only durable event ledger. Each row contains `session_id`, `seq`, globally unique `event_id`, event `type`, timestamp, optional run/turn/causation/correlation ids, and the validated protocol envelope in `payload_json`. |
| `session_messages` | Transcript read projection by message. Used by CLI and desktop inspection without replaying all events. |
| `session_parts` | Normalized message parts such as text, tool call, tool result, reasoning, file, and data parts. |
| `session_awaits` | Wait projection rows for approval-blocked runs, blocking `user_input`, foreground `subagent` waits, and imported legacy awaiting metadata. |
| `mission_runs` | Legacy `.omo/runs/*.json` compatibility import target and new Mission/Run SQL write target in `memory.db`. |
| `approvals` | Approval projection keyed by `approval_id`, including subject, status, request/decision timestamps, and decision metadata. |
| `tool_calls` | Tool-call projection keyed by `tool_call_id`, including name, status, arguments, result, approval id, timestamps, errors, and applied files. |
| `provider_failures` | Provider failure projection keyed by a failure id, with unique `(session_id, event_id)` rows for request/provider-turn diagnostics. |
| `legacy_session_imports` | Idempotent import ledger for JSONL logs and `.omo/runs/*.json` files. Records source path, source kind, checksum, imported event count, import timestamp, and diagnostics. |

Shared local `memory.db` runtime tables:

| Table | Responsibility |
| --- | --- |
| `sessions` | Runtime coordination session row shared with the public session-list projection in data-dir `memory.db`. |
| `session_inputs` | Durable input delivery rows for `steer` and `queue` prompts. Tracks admitted/promoted sequence numbers and cancellation. |
| `session_awaits` | Runtime wait rows for blocking input delivery and foreground child-agent waits. |
| `missions` | Materialized workflow mission records mirrored into SQL. The original mission payload is preserved as JSON. |
| `mission_runs` | SQL run records with parent run id, linked session id, child agent kind/id, child session ids, retry state, status timestamps, prompt, and passthrough JSON. |
| `context_epochs` | Pull-based system-context epoch records by session, epoch, and source. |
| `runtime_agents` | Durable mirror of visible runtime agent references when a `SqlAgentJobMirror` is injected. |
| `async_jobs` | Durable mirror of background and foreground child-agent jobs when a `SqlAgentJobMirror` is injected. |

Session projection tables:

| Table | Responsibility |
| --- | --- |
| `session_projection_runs` | Run-event projection for session list/detail reads. It records event id, sequence, event type, command/state, run/input/provider ids, reason, and error code. |
| `session_projection_diagnostics` | Projection diagnostics produced while importing legacy session data. |

## Key Indexes

The schema indexes the query paths that are used by replay, listings,
awaiting-state rendering, child lookup, and import diagnostics:

| Table | Key or index | Used for |
| --- | --- | --- |
| `session_events` | Primary key `(session_id, seq)` | Ordered replay and deterministic prefix reads. |
| `session_events` | Unique `event_id` | Duplicate-event protection during append/import. |
| `session_events_session_type_idx` | `(session_id, type)` | Event-type filtering for projections and diagnostics. |
| `session_events_run_idx` | `run_id` | Run-scoped event lookup. |
| `sessions_status_listing_idx` | `(status, last_activity_at)` | Session list/status views. |
| `sessions_parent_session_idx` | `parent_session_id` | Parent-to-child session tree listing. |
| `sessions_root_session_idx` | `root_session_id` | Full session tree grouping. |
| `session_awaits_pending_idx` | `(session_id, reason, created_at)` filtered to `status = 'pending'` | Fast pending-wait lookup and display-priority selection. |
| `session_awaits_source_idx` | `(source_kind, source_id)` | Resolving waits by approval, input, job, run, or child source. |
| `session_awaits_child_session_idx` | `child_session_id` | Blocking child-session lookup. |
| `session_inputs_queue_idx` | `(session_id, status, created_at)` | Pending/admitted input ordering. |
| `session_inputs_delivery_idx` | `(delivery, status)` | Steer vs queue promotion counts. |
| `session_messages_session_idx` | `(session_id, seq)` plus unique `(session_id, seq)` | Ordered transcript inspection. |
| `session_parts_session_idx` | `(session_id, message_id)` plus unique `(message_id, part_index)` | Ordered message part reconstruction. |
| `mission_runs_mission_status_idx` | `(mission_id, status)` | Workflow run listing by mission/status. |
| `mission_runs_session_idx` | `session_id` | Session-to-run lookup. |
| `mission_runs_parent_run_idx` | `parent_run_id` | Run tree lookup. |
| `approvals_session_status_idx` | `(session_id, status)` | Pending approval projection. |
| `approvals_subject_idx` | `(subject_kind, subject_id)` | Approval lookup by guarded tool/resource. |
| `tool_calls_session_status_idx` | `(session_id, status)` | Tool outcome summaries. |
| `tool_calls_run_idx` | `run_id` | Run-scoped tool lookup. |
| `tool_calls_approval_idx` | `approval_id` | Tool-to-approval join. |
| `provider_failures_request_idx` | `(session_id, request_id)` | Provider request diagnostics. |
| `context_epochs_session_epoch_source_unique` | `(session_id, epoch, source_id)` | Idempotent context-source epoch writes. |
| `runtime_agents_session_idx` | `session_id` | Live/adopted agent lookup by session. |
| `runtime_agents_parent_idx` | `parent_agent_id` | Agent lineage traversal. |
| `runtime_agents_status_idx` | `(status, updated_at)` | Agent dashboard/status listing. |
| `async_jobs_status_idx` | `(status, queued_at)` | Queued/running/completed job listing. |
| `async_jobs_parent_session_idx` | `parent_session_id` | Parent session job listing. |
| `async_jobs_child_session_idx` | `child_session_id` | Child session to job lookup. |
| `async_jobs_agent_idx` | `agent_id` | Agent-scoped job lookup. |
| `legacy_session_imports_source_checksum_unique` | `(source_path, checksum)` | Idempotent legacy import. |
| `legacy_session_imports_source_idx` | `source_path` | Import audit by source file. |
| `session_projection_runs_by_sequence` | `(session_id, sequence)` | Run-event projection ordering. |

## Event And Projection Contract

`session_events` is the durable replay contract. New authoritative writes append
validated `AgentEventEnvelope` payloads into that table, allocate the next
per-session `seq` through `session_event_sequences`, and update the `sessions`
summary row in the same deterministic append path. Event rows are never edited
to change history.

Projection tables are read models derived from event envelopes or runtime
state. They may be deleted and rebuilt for a session from `session_events` and
legacy import sources. This applies to `session_messages`, `session_parts`,
`approvals`, `tool_calls`, `provider_failures`, `session_projection_runs`,
`session_projection_diagnostics`, and the summary columns on `sessions`.

JSON columns such as `payload_json`, `metadata_json`, `result_json`,
`error_json`, `passthrough_json`, and `diagnostics_json` are boundary payloads.
Callers parse them with protocol or local Zod schemas before using the values.

## Session State Machine

The public session lifecycle values are:

```text
idle -> running -> awaiting -> running
idle -> running -> stopped
idle -> running -> failed
awaiting -> stopped
awaiting -> failed
```

State meanings:

| Status | Meaning |
| --- | --- |
| `idle` | No active run and no pending wait blocks progress. |
| `running` | A run or foreground operation is active and can progress. |
| `awaiting` | The session cannot progress until a pending wait resolves. The wait reason and source live in `session_awaits`, with display columns mirrored on `sessions`. |
| `stopped` | A terminal stop event has been recorded. |
| `failed` | A terminal failure has been recorded. |

Terminal state wins over active waits. Otherwise, lifecycle derivation chooses
the highest-priority pending wait, then falls back to active runs, then `idle`.
The full `approval` / `user_input` / `subagent` priority order is production-wired
through the public data-dir session-list/read path.

## Awaiting Semantics

`awaiting` is not a generic blocked string. It is a session lifecycle status plus
typed reason/source metadata:

| Reason | When it applies | Common source fields |
| --- | --- | --- |
| `approval` | A tool/workspace approval is pending or a run is blocked on approval. | `approval_id`, optional `tool_call_id`, optional `run_id`. |
| `user_input` | The session explicitly needs operator input, clarification, plan approval, or a blocking queued input promotion. | `source_kind = 'operator'` or `run`, `source_id`, optional `run_id`. |
| `subagent` | The parent is synchronously blocked on a foreground child session or foreground subagent job. | `job_id`, `child_session_id`, optional `run_id`. |

`session_awaits` stores active waits in the public `memory.db` projection.
`sessions.primary_wait_id` selects the display wait with priority `approval`,
then `user_input`, then `subagent`. Resolving or cancelling the last pending wait
recomputes the session lifecycle to `running`, `idle`, `stopped`, or `failed`.

Detached background jobs do not make the parent `awaiting/subagent`. They stay
visible in `async_jobs` and can be listed from the parent session, but the parent
can continue.

## Subagent Lineage And Jobs

Subagent persistence has three layers:

| Layer | Tables | Contract |
| --- | --- | --- |
| Session lineage | `sessions`, `mission_runs`, `session_relations` | Child sessions remain addressable through parent/root session ids, mission-run child ids, and relation rows. Foreground subagent waits and persisted async job rows insert `session_relations` rows with `kind = 'subagent'`; fork/clone/compaction/import/export relation kinds are schema-supported as producers wire them. |
| Runtime agent refs | `runtime_agents` | Mirrors the live registry for adopted agents when a `SqlAgentJobMirror` is injected. It records lifecycle status, parent agent id, session id, and park/revive metadata, but the in-memory lifecycle manager still owns live coordination. |
| Job handles | `async_jobs` | Mirrors `AsyncJobManager` jobs when a `SqlAgentJobMirror` is injected, with queued/running/terminal status, cancellation reason, result, error, parent session id, and child session id. Active jobs recovered after restart are cancelled rather than auto-reexecuted. |

Foreground child work writes a pending public `session_awaits` row with
`reason = 'subagent'` and records the corresponding `async_jobs` row as blocking
when the SQL mirror is wired into the task runtime. Resolving the child marks
the wait `resolved` and updates the job terminal state. Detached jobs only write
`async_jobs`; they do not create a blocking wait.

## Legacy Import And Export

The local DB opener applies the current schema directly with `CREATE TABLE IF NOT EXISTS`
statements. Legacy compatibility import is additive and idempotent:

1. `ensureLocalSessionDatabase` opens `<data-dir>/memory.db`, ensures the
   current schema, and then runs the legacy compatibility importer.
2. JSONL logs under `<data-dir>/sessions/*.jsonl` are parsed as validated event
   envelopes and inserted into `session_events`.
3. `.omo/runs/*.json` records are parsed through the mission-run protocol schema
   and upserted into `mission_runs`.
4. `legacy_session_imports` records the source path, source kind, checksum,
   imported event count, timestamp, and any diagnostics.

The importer uses `(source_path, checksum)` to skip already imported files. It
uses `INSERT OR IGNORE` for legacy event rows so duplicate event ids do not
corrupt the event stream. Corrupt files produce diagnostics in
`legacy_session_imports`; they do not delete source files.

Export reads ordered envelopes from `session_events`, reconstructs replayable
JSONL/archive output, and marks `sessions.exported_at`. Export is explicit:
SQLite-native writes do not create sidecar JSONL files unless the operator asks
for rollback/read compatibility output.

Future explicit local DB migrations are still supported by `runLocalDbMigrations`
and record applied ids in `schema_migrations` when that runner is used. The
development-time file-to-DB transition described here does not preserve
historical migration scripts for the current schema shape.

## Local Path And Memory Relationship

The local session DB path is:

```text
${MCTRL_DATA_DIR}/memory.db
```

When `MCTRL_DATA_DIR` is unset, the platform Mission Control data directory is
used. The local opener builds a `file:` URL for that path and creates the data
directory when needed.

`memory_entries`, session event/replay tables, blocking input delivery, and
agent/job mirror tables intentionally share `memory.db`. `:memory:` remains
available for tests and ephemeral stores.

Legacy JSONL logs, if present, remain at `<data-dir>/sessions/<session-id>.jsonl`
and are treated as import/export compatibility artifacts.

## Rollback And Operations

Operational rollback is data-preserving:

- Keep the original JSONL and run JSON files. Import never rewrites or deletes
  them.
- Use `mctrl session export <id> <path>` to produce a checksummed replay archive
  from SQLite-native rows for older readers or rollback inspection.
- Use `legacy_session_imports` to audit which legacy files were imported, which
  checksum was used, and what diagnostics were recorded.
- Remote database URLs, auth tokens, embedded replica sync, and network sync
  behavior are intentionally absent because remote Turso is out of scope.

Authoritative source files:

- `packages/core/src/db/local-libsql-db.ts`
- `packages/core/src/db/local-libsql-schema*.ts`
- `packages/core/src/db/session-*-schema.ts`
- `packages/core/src/memory/sqlite-session-event-store*.ts`
- `packages/core/src/memory/sqlite-session-projection*.ts`
- `packages/core/src/memory/session-import*.ts`
- `packages/core/src/runtime/local-runtime-db.ts`
- `packages/core/src/runtime/session-input-delivery-sql.ts`
- `packages/core/src/runtime/mission-run/*store.ts`
- `packages/core/src/agents/agent-job-sql-mirror*.ts`
