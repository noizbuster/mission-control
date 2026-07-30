<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# hashline

## Purpose

Clean-room hashline edit-by-hash algorithm: per-line content hashes (xxHash32 → 2-char CID), line-ref parse/validate, bottom-up edit ordering, overlap detection, and apply execution. Tool entry/schemas live in parent `../hashline-edit.ts` and `../hashline-edit-schemas.ts`.

## Key Files

| File | Description |
|------|-------------|
| `hash-computation.ts` | Alphabet/dict, ref/output patterns, line hash primitive |
| `validation.ts` | `LineRef` parse/normalize; `HashlineMismatchError` |
| `edit-operations.ts` | `normalizeEdit` / `normalizeEdits` |
| `edit-ordering.ts` | Replace/append/prepend types, bottom-up compare, overlap detection |
| `hashline-edit-executor.ts` | `executeHashlineEdits` → `HashlineEditOutcome` |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Algorithm inspired by upstream harness hashline; **no source expressions copied**. License notes in `.mc/evidence/license-matrix.md`.
- Keep hash alphabet and ref patterns stable — model-facing format.
- Apply edits bottom-up; reject overlapping ranges.
- Mismatch between provided hash and current line content must fail clearly (`HashlineMismatchError`).
- Parent tool owns workspace guards, permissions, and diff events — this dir is pure transform/execute.

### Testing Requirements

- Covered primarily by parent `../hashline-edit.test.ts`
- Prefer unit tests here if splitting pure algorithm cases

### Common Patterns

- Normalize → validate refs against current file → order → execute
- Pure functions; no I/O in this directory

## Dependencies

### Internal

- Parent `../hashline-edit.ts` for tool registration and FS apply path
- `@mission-control/protocol` diff types where surfaced by parent

### External

- xxHash32 (public BSD-2-Clause algorithm by Yann Collet) as hash primitive

<!-- MANUAL: -->
