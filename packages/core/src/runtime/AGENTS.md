<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# runtime

## Purpose

Session run coordination: `SessionRunOwner`, interactive run coordinator (queue/steer/resume/interrupt), per-key drain-lane coordinator v2 with session-input delivery, graph turn-runner adapter, bounded scheduler, session-control ownership/leases/operations/stop-tree, crash recovery, plus Mission/Run store and session-spanning continuation runtime (subdirs).

## Key Files

| File | Description |
|------|-------------|
| `run-owner.ts` | `SessionRunOwner` — tool registry, turn runner, durable sink, provider envelope forwarding |
| `run-owner-prompt-input.ts` | Prompt input shaping for owner admission |
| `run-coordinator.ts` | Interactive coding-agent coordinator entry |
| `run-coordinator-lifecycle.ts` | Wake/run/resume/interrupt drain loop + receipt settlement |
| `run-coordinator-admission.ts` | Prompt admission gates |
| `run-coordinator-drain.ts` | Drain-loop internals |
| `run-coordinator-engine.ts` | Coordinator engine core |
| `run-coordinator-active-run.ts` | Active-run tracking |
| `run-coordinator-messages.ts` | Coordinator message helpers |
| `run-coordinator-promotion.ts` | Steer/queue promotion |
| `run-coordinator-ids.ts` | Run/coordinator id helpers |
| `run-coordinator-types.ts` | `RunCoordinatorTurnRunner`, `SessionRunOwnerOptions` |
| `run-coordinator-v2.ts` | `RunCoordinatorV2` — per-key drain-lane, demand coalesce, interrupt seq suppression |
| `session-input-delivery.ts` | FIFO steer/queue admission (`admitInput`, `promoteSteers`, …) |
| `session-input-delivery-sql.ts` | SQL-backed input delivery |
| `graph-coordinator-turn.ts` | `createGraphTurnRunner` — adapts `runAbgGraph` as turn runner |
| `graph-coordinator-turn-messages.ts` | Turn message assembly / duplicate-id handling |
| `graph-resume-state.ts` | Graph resume state capture/restore |
| `scheduler.ts` | Bounded scheduler (graph/provider-tool/shell gates at runtime layer) |
| `execution-context.ts` | Execution context bag |
| `executor.ts` | Low-level executor seam |
| `local-runtime-db.ts` | Local runtime DB access for session control |
| `session-control-host.ts` | Session control host API |
| `session-control-process.ts` | Process-level control wiring |
| `session-control-lease.ts` | Ownership lease acquire/renew |
| `session-control-operation.ts` | Control operations + settlement/GC |
| `session-control-owner-posix.ts` | POSIX owner takeover/stale/release |
| `session-control-owner-windows.ts` | Windows owner path |
| `session-control-proxy-windows.ts` | Windows proxy lifecycle |
| `session-control-platform.ts` | Platform dispatch |
| `session-control-cancellation.ts` | `SessionControlEpoch` cancellation |
| `session-control-registry-*.ts` | Registry file/auth/paths |
| `session-owner-control-*.ts` | Owner control client/server/framing/token |
| `session-stop-service.ts` | Stop service orchestration |
| `session-stop-tree.ts` | Stop-tree resolve/fixed-point |
| `session-stop-mutation.ts` | Stop mutations |
| `session-crash-recovery.ts` | Crash recovery paths |
| `session-child-spawn-barrier.ts` | Child spawn barrier |
| `session-store-identity.ts` | Session store identity helpers |
| `session-tree-token.ts` | Session tree token |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `continuation/` | Session-spanning `ContinuationRuntime` (see `continuation/AGENTS.md`) |
| `mission-run/` | Mission/Run SQL stores + service (see `mission-run/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Coordinator owns queue/steer/resume around the installed turn runner.
- Tool registries are built by CLI (`createInteractiveToolRegistry` / `createNonInteractiveToolRegistry`) and passed in — runtime does **not** own tool registration.
- `haltOnFailedToolSettlement: true` terminates on first non-approval, non-retryable tool failure.
- Graph turn runner seeds `initialMessages` from admitted conversation and threads approval decisions.
- `RunCoordinatorV2` = workflow-path drain-lane; original `run-coordinator*.ts` = interactive coding-agent. Both coexist by design.
- Mission/Run authoritative state is SQL in `mission-control.db`; JSONL is session timeline/replay compatibility only — never authoritative Run store.
- Run transitions must go through `assertRunTransition` / `updateRunStatus`: pending→{running,cancelled}; running→{blocked,completed,failed,cancelled}; blocked→{running,cancelled}.
- `blocked` is nonterminal/resumable; `cancelled` is terminal with `terminalReason`; timestamps auto-managed.
- Do not bypass `scheduleQueuedNodes` for runnable nodes.
- Graph events require `graphId`, `sessionId`, timestamp.
- SDK must not own observe→decide→act — graph pins `stopWhen: stepCountIs(1)`.

### Testing Requirements

- Coordinator/turn: `run-coordinator-*.test.ts`, `run-coordinator-v2.test.ts`, `graph-coordinator-turn*.test.ts`
- Session control: `session-control-*.test.ts`, `session-owner-control*.test.ts`, `session-stop-*.test.ts`
- Resume/crash: `session-resume-abg-regression.test.ts`, `session-crash-recovery.test.ts`
- Mission/continuation: see subdir tests
- Owner consumers also live in `apps/cli` (`run-agent-owner-prompt.ts`, `interactive-coding-agent.ts`)
- Focused: `pnpm exec vitest run packages/core/src/runtime/<file>.test.ts`

### Common Patterns

- Demand coalescing via `coalesceDemand` on v2 lanes; `awaitIdle` for drain completion.
- Session input: steers promote before queued prompts.
- POSIX owner uses lease + forgery defenses; Windows has separate proxy/owner modules.
- Stop-tree resolves child sessions to fixed point before mutation.
- `local-runtime-db` backs control SQL; do not open ad-hoc DB handles beside it.

## Dependencies

### Internal

- `../behavior/` — `runAbgGraph`, coding-agent graph
- `../memory/` — session event store projections
- `../persistence/` — boulder store (continuation passthrough)
- `../db/` — libSQL / schema access patterns
- `@mission-control/protocol` — run/session control schemas

### External

- Node `crypto` / process primitives for owner tokens and leases

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
