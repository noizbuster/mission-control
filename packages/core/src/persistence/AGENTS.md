<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# persistence

## Purpose

Workspace-local agent state under `.mc/` (distinct from `.mctrl/` project config): path helpers, atomic writes, plan store/format/scaffold, append-only notepads, boulder work/task-session records, and JSON compatibility file I/O.

## Key Files

| File | Description |
|------|-------------|
| `paths.ts` | `resolveMcRoot`, `ensureMcDirs`, subdir constants (plans/notepads/missions/runs) |
| `atomic-write.ts` | `atomicWriteFile` / text / JSON |
| `plan-store.ts`, `plan-format.ts`, `plan-scaffold.ts` | Plan read/parse/checklist/scaffold |
| `notepad-store.ts` | Append-only notepad files |
| `boulder-store.ts`, `boulder-work-mutation.ts` | Boulder work + task session schemas/mutations |
| `draft-frontmatter-io.ts` | Draft frontmatter read/write |
| `json-compatibility-file.ts` | Backward-compatible JSON file load/save |
| `*.test.ts` | persistence/plan/scaffold coverage |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- `.mc/` = runtime agent state; `.mctrl/` = project config (agents/workflows/skills) — do not conflate.
- Notepads are append-only (`assertAppendOnly` / `NotepadAppendOnlyError`); pair with `../tools/notepad-guard/`.
- Prefer `atomicWrite*` for durable replacements.
- Boulder schemas tolerate optional fields where historical works are inconsistent — parse leniently, write strictly where versioned.
- Ensure dirs via `ensureMcDirs` before first write.

### Testing Requirements

- `persistence.test.ts`, `plan-store.test.ts`, `plan-format.test.ts`, `plan-scaffold.test.ts`

### Common Patterns

- resolve root → ensure subdirs → atomic write / append
- Plan checklist parsing shared by tools and UI

## Dependencies

### Internal

- Tools (plan-exit, notepad paths), runtime boulder consumers
- `@mission-control/protocol` where schemas shared

### External

- Node fs/promises

<!-- MANUAL: -->
