<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# notepad-guard

## Purpose

Enforces append-only writes under `.mc/notepads/`. Any non-append write operation targeting a notepad path is rejected before mutation.

## Key Files

| File | Description |
|------|-------------|
| `notepad-guard.ts` | `isNotepadPath`, `assertNotepadWriteAllowed`, operation types, `NotepadGuardError` |
| `notepad-guard.test.ts` | Path detection and allow/deny matrix |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Only append operations are permitted inside notepad paths; overwrite/delete/rename-style ops must throw `NotepadGuardError`.
- Pair with `../../persistence/notepad-store.ts` for actual append I/O.
- Keep path detection aligned with `.mc/notepads/` layout from persistence `paths.ts`.

### Testing Requirements

- `notepad-guard.test.ts` — run focused vitest on this file

### Common Patterns

- Call `assertNotepadWriteAllowed` at the start of any tool write path that might touch notepads

## Dependencies

### Internal

- `../../persistence/` — notepad paths and append store
- Parent tools that mutate files (`file-write`, `file-edit`, etc.)

### External

- None

<!-- MANUAL: -->
