<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# memory

## Purpose

Durable session memory and related stores: data-dir resolution, local libSQL session event store + projections, JSONL session log import/export (payload format only — not authoritative Run state), persistent working-memory (sqlite/turso/in-memory), ABG blackboard (mutable per-run scratch), archive validation/import, and session lifecycle/identity SQL helpers. Authoritative Mission/Run records live in SQL `mission_runs`.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public exports for stores, archives, projections, data-dir |
| `data-dir.ts` | `resolveMissionControlDataDir` / env key |
| `local-session-store.ts`, `local-session-store-*.ts` | Open/delete/replay/paths for local session DB |
| `sqlite-session-event-store*.ts` | Append-only event store implementation + SQL/rows/tx |
| `sqlite-session-projection*.ts` | Projection statements/rows/decoders into SQL tables |
| `jsonl-session-*.ts` | JSONL log parse/files/projection/errors (archive format) |
| `session-archive-*.ts` | Create/parse/validate/import session archives |
| `session-projection.ts`, `session-projection-types.ts` | Derive projection records from events |
| `session-identity-sql.ts`, `session-lifecycle-sql-authorities.ts`, `session-awaiting-sql.ts` | Identity/lifecycle/await SQL |
| `session-status-derivation.ts`, `session-tree-projection.ts`, `session-stop-projection*.ts` | Status/tree/stop projections |
| `sqlite-session-approval-effects.ts`, `sqlite-session-desktop-tool-proposals.ts` | Approval effects + desktop proposals persistence |
| `memory-store.ts` | `MemoryStore` interface / compaction input types |
| `persistent-memory-store.ts`, `sqlite-persistent-store.ts`, `turso-persistent-store.ts` | Working-memory backends |
| `persistent-store-factory.ts` | `createPersistentStore` + Turso probe |
| `blackboard.ts` | Per-run mutable ABG blackboard |
| `in-memory-store.ts` | In-memory event store for tests |
| `*.test.ts` | Broad coverage (concurrency, delete, replay parity, turso wiring) |

## Subdirectories

_None (skip generated/test-only noise)._

## For AI Agents

### Working In This Directory

- Event streams are append-only; derive projections — do not mutate history.
- JSONL is archive/payload format only; never treat JSONL as authoritative Run/Mission state (`mission_runs` SQL owns that).
- Open DB via `../db` lease + write-lane discipline; do not hand-roll parallel writers.
- Blackboard ≠ durable store: one instance per graph run, shared across nodes via run context.
- Preserve import validation (`session-archive-validation`) before writing local rows.
- Redact secrets at boundaries; do not log raw credentials from stored payloads.

### Testing Requirements

- Prefer focused files under this dir (`pnpm exec vitest run packages/core/src/memory/<file>.test.ts`)
- Concurrency/transaction/delete/parity tests are load-bearing for store changes

### Common Patterns

- open store → append events → project → read projections/replay
- Factory selects sqlite vs turso vs in-memory persistent backend

## Dependencies

### Internal

- `../db/` — libSQL open, schema, write lane
- `@mission-control/protocol` — event envelopes and schemas
- `../providers/` redaction helpers where projecting sensitive text
- Consumers: runtime, desktop commands, tools/session-*, abg-overlay

### External

- `@libsql/client` / turso; optional legacy better-sqlite3 types (`better-sqlite3.d.ts`)

<!-- MANUAL: -->
