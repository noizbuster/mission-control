# Session Data Model

Mission Control uses one shared local libSQL surface for durable sessions. The
canonical database path and identity are shared by session storage, owner IPC,
leases, and Ground Control's Mission Control adapter:

- `<MCTRL_DATA_DIR>/mission-control.db` is the authoritative session event/replay
  database. New coding-agent session appends write `session_events` there, replay
  and session-list projections are derived from those events, production
  `user_input` and foreground `subagent` waits are mirrored there, and legacy
  JSONL import/export compatibility uses this database. Runtime coordination SQL
  for session inputs, Mission/Run records, context epochs, runtime agents,
  async jobs, and relation rows uses the same local-only data-dir `mission-control.db`
  file. `session_events` is authoritative for session, run, approval, and input
  history. `mission_runs` is the authoritative durable SQL Run store, and
  `async_jobs` is authoritative for durable job work, so lifecycle refresh
  consults all three authorities.

Remote Turso is out of scope: the local DB opener accepts `:memory:` and `file:`
URLs only, rejects `libsql://` and other remote schemes, and does not read auth
tokens or configure sync.

Legacy JSONL session logs remain session-timeline and import/export compatibility
inputs. A normal session-store open automatically discovers
`sessions/*.jsonl`, imports each source idempotently, and leaves the source
unchanged. JSONL is not authoritative Run storage, and explicit export can
write a SQLite-native session back to JSONL/archive form.

This is a bounded local persistence contract, not a remote scheduler or replica:
there is no Turso sync, vector index, automatic job re-execution, or implicit
workflow resume. Mission/Run and job authorities remain durable and explicit.
Blocked Runs resume only through an explicit lifecycle action; cancelled Runs
are terminal and cannot resume.

## Contents

- [Authoritative Tables](#authoritative-tables)
- [Local Database Runtime Contract](#local-database-runtime-contract)
- [Key Indexes](#key-indexes)
- [Event And Projection Contract](#event-and-projection-contract)
- [Session State Machine](#session-state-machine)
- [Stop Events And Lifecycle Authority](#stop-events-and-lifecycle-authority)
- [Awaiting Semantics](#awaiting-semantics)
- [Owner IPC, Leases, And Operations](#owner-ipc-leases-and-operations)
- [Subagent Lineage And Jobs](#subagent-lineage-and-jobs)
- [Compatibility Import And Explicit Export](#compatibility-import-and-explicit-export)
- [Local Path And Memory Relationship](#local-path-and-memory-relationship)
- [Hierarchy And Guarded Deletion](#hierarchy-and-guarded-deletion)
- [Backup And Operations](#backup-and-operations)

## Authoritative Tables

Core `<MCTRL_DATA_DIR>/mission-control.db` tables:

| Table | Responsibility |
| --- | --- |
| `memory_entries` | Existing persistent working-memory key/value table. It shares `mission-control.db` and is not a session replay table. |
| `sessions` | Current session projection and listing row. Stores lifecycle status, optional `awaiting_reason`, `primary_wait_id`, parent/root ids, workspace/provider/model/title metadata, token/cost summaries, last event sequence, activity timestamps, legacy JSONL path, import/export timestamps, and `metadata_json`. |
| `session_event_sequences` | Per-session sequence allocator. The event store updates `next_seq` transactionally with append writes so replay order is stable per session. |
| `session_events` | Append-only durable event ledger. Each row contains `session_id`, `seq`, globally unique `event_id`, event `type`, timestamp, optional run/turn/causation/correlation ids, and the validated protocol envelope in `payload_json`. |
| `session_messages` | Transcript read projection by message. Used by CLI and desktop inspection without replaying all events. |
| `session_parts` | Normalized message parts such as text, tool call, tool result, reasoning, file, and data parts. |
| `session_awaits` | Wait projection rows for approval-blocked runs, blocking `user_input`, foreground `subagent` waits, and imported legacy awaiting metadata. |
| `mission_runs` | Authoritative durable Mission/Run SQL storage in `mission-control.db`; `.omo/runs/*.json` remains a separate compatibility format. |
| `approvals` | Approval projection keyed by `approval_id`, including subject, status, request/decision timestamps, and decision metadata. |
| `tool_calls` | Tool-call projection keyed by `tool_call_id`, including name, status, arguments, result, approval id, timestamps, errors, and applied files. |
| `desktop_tool_proposals` | Private exact tool-call payloads used only to execute a later desktop approval. Public events and replay stay redacted. Reusing one tool-call id with different content marks the proposal conflicted and non-executable. |
| `desktop_approval_effects` | At-most-once ledger for one approved desktop tool effect, separate from approval decision history. It records exact identity, `pending -> executing -> settled | unknown`, an opaque execution token and lease, known outcomes, and execution/recovery/resolution timestamps. |
| `provider_failures` | Provider failure projection keyed by a failure id, with unique `(session_id, event_id)` rows for request/provider-turn diagnostics. |
| `legacy_session_imports` | Idempotent compatibility-import ledger keyed by source path and checksum. Normal session-store opens use it for `sessions/*.jsonl`; callers that opt into Run sources can also record `.omo/runs/*.json` files. |

Shared local `mission-control.db` runtime tables:

| Table | Responsibility |
| --- | --- |
| `sessions` | Runtime coordination session row shared with the public session-list projection in data-dir `mission-control.db`. |
| `session_inputs` | Durable input delivery rows for `steer` and `queue` prompts. Tracks admitted/promoted sequence numbers and cancellation. |
| `session_awaits` | Runtime wait rows for blocking input delivery and foreground child-agent waits. |
| `missions` | Materialized workflow mission records mirrored into SQL. The original mission payload is preserved as JSON. |
| `mission_runs` | SQL run records with parent run id, optional linked session id, child agent kind/id, child session ids, retry state, status timestamps, prompt, and passthrough JSON. A `blocked` Run is nonterminal and carries no `terminalReason`; a `cancelled` Run is terminal and carries its cancellation `terminalReason` plus `endedAt`. |
| `context_epochs` | Pull-based system-context epoch records by session, epoch, and source. |
| `runtime_agents` | Durable mirror of visible runtime agent references when a `SqlAgentJobMirror` is injected. |
| `async_jobs` | Durable mirror of background and foreground child-agent jobs when a `SqlAgentJobMirror` is injected. |
| `session_relations` | Relation rows used only as a constrained fallback when an explicit session parent is absent. |
| `session_control_leases` | DB-identity-scoped owner lease for a live session, including owner id, epoch, nonce hash, and wall-clock expiry. |
| `session_control_operations` | Immutable stop operation receipt, captured and settled handle ids, barrier state, deadline, and retention fields. |
| `session_control_late_settlements` | Redacted audit rows for callbacks rejected after an operation or owner lease is stale. |

## Local Database Runtime Contract

The product opener resolves and opens `<MCTRL_DATA_DIR>/mission-control.db`
directly. Runtime startup does not probe, attach, or import a separate older SQL
database file. Schema setup migrates legacy projection table names in place
within the already-open canonical database: `session_index_runs` is copied into
`session_projection_runs` and then dropped, and
`session_index_diagnostics` is copied into `session_projection_diagnostics` and
then dropped. Within one process, every canonical database file has one leased
libSQL client and one Drizzle handle. Another process owns its own client for the
same file.

Every in-process mutation, including schema initialization, enters the explicit
file-scoped write lane. Drizzle is a query layer and does not provide this
serialization. Cross-process contention is bounded by a 5000 ms busy timeout.
Before a client is published, the opener enables and verifies
`foreign_keys=ON`. File-backed clients additionally establish and verify
`journal_mode=WAL`, `synchronous=NORMAL`, and the busy timeout.

The persistent working-memory adapter may remain unavailable when its optional
libSQL native binary cannot be loaded. Once a local file configuration reaches
the opener, however, `LocalDbConfigError` and `LocalDbInitializationError` are
fatal typed errors. An invalid local target or refused WAL/NORMAL/timeout
contract never silently falls back.

Session projection tables:

| Table | Responsibility |
| --- | --- |
| `session_projection_runs` | Run-event projection for session list/detail reads. It records event id, sequence, event type, command/state, run/input/provider ids, reason, and error code. |
| `session_projection_diagnostics` | Projection diagnostics produced while importing legacy session data. |

Exact desktop tool proposals are recorded transactionally before their public
events are redacted. They are private execution authority, not event, replay,
or archive data. A repeated tool-call id with a different name or arguments is
marked conflicted and cannot be approved or executed.

`desktop_approval_effects` is a separate at-most-once ledger. Reserving an
effect stores its exact session, approval, run, tool-call, tool name, arguments,
and workspace identity as `pending`. A full-identity claim records an opaque
execution token and lease while advancing to `executing`. Known tool result
events are appended durably before that same token can advance the row to
`settled` with a `completed` or `failed` outcome. Claims and settlements use the
store clock; an owner cannot claim with an already-expired lease or settle at or
after lease expiry. An expired execution advances only to `unknown`; it is never executable again. An operator can attach a
`completed` or `failed` resolution to `unknown` without running the tool.
Approval requests and decisions remain in `approvals` and `session_events`.

Canonical schema setup detects only the exact older ten-column effect table and
rebuilds that shape in place. Legacy `pending` rows remain pending, legacy
`settled` rows become `unknown`, and orphaned rows are not copied. Other table
shapes fail closed instead of entering a general migration framework.

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
| `desktop_approval_effects_state_idx` | `state` | Pending, executing, settled, and unknown effect work. |
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
| `session_control_leases` | Primary key `(db_identity, session_id)` | Exact-session owner lookup and epoch fencing. |
| `session_control_operations` | Primary key `(db_identity, session_id, operation_id)` | Receipt replay, timeout tombstones, and stale callback fencing. |

## Event And Projection Contract

`session_events` is the durable replay contract for session, run, approval, and
input history. New writes append validated `AgentEventEnvelope` payloads into
that table, allocate the next per-session `seq` through
`session_event_sequences`, and update the `sessions` summary row in the same
deterministic append path. Event rows are never edited to change history.

The event ledger is not the only lifecycle authority. `mission_runs` remains
the source of truth for nonterminal Mission work, and live jobs plus the durable
`async_jobs` mirror remain the source of truth for job work. Lifecycle refresh
reaches `idle` only after event-derived waits and inputs, mission work, and job
work are all quiescent. A replay can rebuild event-derived projections, but it
does not invent mission or job authority.

Run blocking is intentionally narrow. The public `blockRun` service transitions
`running -> blocked` without writing `terminalReason`; the reason remains in the
event stream until typed Run wait metadata exists. `blocked` is nonterminal and
resumable through the explicit `blocked -> running` transition, such as after an
approval decision. It is also cancellable through `blocked -> cancelled`; no
automatic blocked resume exists. The public `cancelRun` service supplies the
cancellation `terminalReason`, and the store auto-manages `endedAt`. `cancelled`
is terminal, has no outgoing transition, and cannot resume.

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
idle -> running -> idle (aborted)
awaiting -> idle (aborted)
idle -> running -> failed
awaiting -> failed
```

State meanings:

| Status | Meaning |
| --- | --- |
| `idle` | No active run and no pending wait blocks progress. |
| `running` | A run or foreground operation is active and can progress. |
| `awaiting` | The session cannot progress until a pending wait resolves. The wait reason and source live in `session_awaits`, with display columns mirrored on `sessions`. |
| `idle (aborted)` | A reusable `idle` session whose latest successful stop marker is `session.abort.completed`. The detail clears when a later `run.started` is recorded. |
| `stopped` | A pre-existing terminal lifecycle value. A session stop does not create this state. |
| `failed` | A terminal failure has been recorded. |

Terminal state wins over active waits. Otherwise, lifecycle derivation chooses
the highest-priority pending wait, then falls back to active runs, then `idle`.
The full `approval` / `user_input` / `subagent` priority order is production-wired
through the public data-dir session-list/read path.

## Stop Events And Lifecycle Authority

A successful stop preserves a reusable session. `prompt.cancelled` prevents a
cancelled prompt from promotion after restart. Pending approval, await, input,
mission-run, and job rows become `cancelled` through their own authorities. An
active or blocked run emits exactly one `run.interrupted` from its finalizer with
`reason = operator_aborted`. A no-run cleanup does not create a synthetic run
event.

The successful stop marker is the nonterminal
`session.abort.completed(operationId, requestId, reason = operator_aborted)`
event. It produces `idle (aborted)` only after all authority checks are quiet.
The marker has no terminal-session meaning and is replaced by the next
`run.started`. Tools retain the binary `completed` or `failed` status contract;
an operator-stopped tool is `failed` with `errorCode = operator_aborted`.
Provider abort information remains in the durable audit event stream but does
not create a provider-outage row in `provider_failures`.

## Awaiting Semantics

`awaiting` is not a generic blocked string. It is a session lifecycle status plus
typed reason/source metadata:

| Reason | When it applies | Common source fields |
| --- | --- | --- |
| `approval` | A tool/workspace approval is pending or a run is blocked on approval. | `approval_id`, optional `tool_call_id`, optional `run_id`. |
| `user_input` | The session explicitly needs operator input, clarification, plan approval, or a blocking queued input promotion. | `source_kind = 'operator'` or `run`, `source_id`, optional `run_id`. |
| `subagent` | The parent is synchronously blocked on a foreground child session or foreground subagent job. | `job_id`, `child_session_id`, optional `run_id`. |

`session_awaits` stores active waits in the public `mission-control.db` projection.
`sessions.primary_wait_id` selects the display wait with priority `approval`,
then `user_input`, then `subagent`. Resolving or cancelling the last pending wait
recomputes the session lifecycle to `running`, `idle`, `idle (aborted)`, or
`failed`.

Detached background jobs do not make the parent `awaiting/subagent`. They stay
visible in `async_jobs` and can be listed from the parent session, but the parent
can continue.

## Owner IPC, Leases, And Operations

Only the live owner may perform an exact-session stop. POSIX uses a user-owned
Unix socket and Windows uses the named-pipe sidecar path. The versioned NDJSON
protocol has `session.acquire`, `session.stop`, and `session.release` requests.
It carries `timeoutMs`, not a caller clock. The owner computes its own monotonic
deadline, retains an acquired operation across a client disconnect, returns a
cached receipt for retries, and releases only explicitly, on lease loss, or at
the deadline.

Leases are keyed by canonical database identity and session id. They renew on a
local monotonic five-second schedule and expire after fifteen seconds of wall
time. Owner id and epoch fence every durable mutation. A renewal failure fences
the owner before later callbacks can write state. Timeout first records the
operation receipt, then releases the barrier; rejected late callbacks enter the
redacted settlement audit rather than changing a newer run. Tokens are opaque,
bound to the exact operation and owner epoch, and are never logged.

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

## Compatibility Import And Explicit Export

Runtime startup opens the unified database directly and does not probe or
automatically import prior SQL stores. It separately runs the JSONL compatibility
importer on every normal session-store open. The importer discovers only
`sessions/*.jsonl`, validates each envelope before insertion, and
`legacy_session_imports` makes the JSONL import idempotent by source path and
checksum. It does not rewrite or delete the JSONL source.

The normal opener passes `includeRunSources: false`, so `.omo/runs/*.json` files
are not auto-imported. Mission and Run JSON records under `.omo/` remain owned
by their own persistence stores. A caller that explicitly opts into Run-source
compatibility import may import those files, with `sessionRunId` stripped and a
`session_owner_stripped` diagnostic recorded when it was present. Only the
canonical runtime owner attach/settle path may persist `sessionRunId`.

Export is explicit. It reads ordered `session_events` and writes JSONL or an
archive only when requested, without deleting or rewriting source files. Public
Run creation is insert-only and rejects a duplicate id rather than replacing an
existing owner or status. Imported terminal reasons are credential-redacted
before entering SQL while compatibility source files remain unchanged.

## Local Path And Memory Relationship

The local session DB path is:

```text
${MCTRL_DATA_DIR}/mission-control.db
```

When `MCTRL_DATA_DIR` is unset, the platform Mission Control data directory is
used. The canonical identity algorithm creates the data directory when absent,
uses `realpath.native` on the data directory or existing database path, creates
the POSIX data directory with mode `0700`, appends `mission-control.db` when needed,
uppercases a Windows drive letter, lowercases a UNC host, converts the
absolute path to a file URL, and hashes the UTF-8 URL `href` with SHA-256. The
lowercase hexadecimal digest is `dbIdentity`. Ground Control uses the same
algorithm and shared path vectors.

`memory_entries`, session event/replay tables, blocking input delivery, and
agent/job mirror tables intentionally share `mission-control.db`. `:memory:` remains
available for tests and ephemeral stores.

Legacy JSONL logs, if present, remain at `<data-dir>/sessions/<session-id>.jsonl`
and are automatically imported by normal session-store opens as idempotent,
source-preserving compatibility artifacts.

## Hierarchy And Guarded Deletion

The canonical session tree uses `sessions.parent_session_id` first. Only when
that field is null may exactly one `parent_child` or `subagent` relation supply a
parent. `root_session_id` is observability metadata, not a tree edge. An orphan,
self edge, parent conflict, cycle, or oversized component is unstable and cannot
be stopped or deleted through the guarded flow.

`mc session stop` visits the default tree recursively, or the target only with
`--only`. `--child-only` leaves the selected parent active and recursively
visits only descendants. Stop acquires barriers before discovery, converges the
tree with bounded rescans, and stops deepest descendants first. Terminal rows
are no-ops but remain traversable.

`mc session delete <id> --expected-tree-token <sha256>` recomputes the canonical
subtree and its token in the same transaction as the non-force delete. A changed
tree or any unexpired matching lease rejects the operation. Deletion affects the
whole canonical subtree, including session rows, projections, and compatibility
artifacts, so callers must present the recursive impact before confirmation.

## Backup And Operations

Backup and export operations are data-preserving:

- Keep the original JSONL and run JSON files. Import never rewrites or deletes
  them.
- Use `mctrl session export <id> <path>` to produce a checksummed replay archive
  from SQLite-native rows.
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
