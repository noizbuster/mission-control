<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# db

## Purpose

Local libSQL / mission-control.db access layer: open helpers, process-wide file lease registry, WAL pragmas, explicit write lane, migrations/schema fragments, session/projection/agent-job SQL schemas, and drizzle schema for persistent working-memory rows.

## Key Files

| File | Description |
|------|-------------|
| `mission-control-db.ts` | `openMissionControlDb` — data-dir resolve + open |
| `local-libsql-db.ts` | `openLocalLibsqlDb`, migrations, `LocalLibsqlDb` |
| `local-libsql-registry.ts` | Per-file lease acquire/quarantine (one client per canonical path/process) |
| `local-libsql-write-lane.ts` | Serialized write lane bind/run/close |
| `local-libsql-pragmas.ts` | WAL/NORMAL/busy_timeout setup |
| `local-libsql-identity.ts` | DB identity helpers |
| `local-libsql-transaction.ts` | Transaction helpers |
| `local-libsql-schema*.ts` | Schema fragments (events, projections, runtime, memory, approvals, agent jobs, session identity/control) |
| `schema.ts` | Drizzle `memoryEntries` table (persistent memory; no drizzle-kit codegen) |
| `drizzle-client.ts` | Thin drizzle client helper |
| `session-*-schema.ts`, `session-schema-literals.ts`, `session-record-schema.ts` | Session SQL/Zod schema pieces |
| `*.test.ts` | Lease, write lane, pragmas, migrations, cross-process, integration |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `test-fixtures/` | DB test fixtures (skip generating nested AGENTS) |

## For AI Agents

### Working In This Directory

- Canonical DB is `mission-control.db` under the resolved data dir. One leased client per file/process; explicit in-process write lane; WAL/NORMAL; 5000 ms busy timeout.
- Runtime startup does not probe older standalone SQL files; migrations only rename legacy projection tables in-place inside the canonical DB.
- Do not bypass the write lane for mutating SQL.
- Drizzle schema mirrors `memory/sqlite-persistent-store.ts` on-disk shape; tables also created via raw `CREATE TABLE IF NOT EXISTS` in stores.
- Keep schema fragments additive and migration-ledgered.

### Testing Requirements

- Focused: `local-libsql-*.test.ts`, `mission-control-db-integration.test.ts`, `session-schema.test.ts`
- Cross-process and write-architecture tests are load-bearing — do not skip when changing leases/lanes

### Common Patterns

- `acquireLocalLibsqlFileLease` → open → `bindLocalLibsqlWriteLane` → migrate
- Quarantine client/lane on poison errors

## Dependencies

### Internal

- `../memory/data-dir.ts`, `../memory/local-session-store-paths.ts`
- Consumers: `../memory/` session/event/projection stores

### External

- `@libsql/client`, drizzle-orm (schema only)

<!-- MANUAL: -->
