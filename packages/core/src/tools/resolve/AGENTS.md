<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# resolve

## Purpose

Hidden coordination tool that applies or discards a queued staged preview (e.g. `ast_edit` proposal). Peeks session-scoped `StagedPreviewRegistry`, runs apply/discard closure, consumes the slot.

## Key Files

| File | Description |
|------|-------------|
| `resolve-tool.ts` | `createResolveToolRegistration`, schemas, apply/discard semantics |
| `resolve-tool.test.ts` | Apply/discard happy paths and empty-slot behavior |
| `resolve-approval-identity.test.ts` | Approval identity coupling |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Capability class `'edit'`. Always available alongside tools that stage previews (wiring concern at registry assembly — no separate suppress flag).
- `discard` with nothing pending = success (desired end-state already holds).
- `apply` with nothing pending = clear error.
- Does not re-implement edit logic — dispatches staged closures from `../staged-preview-registry.ts`.
- Preserve approval identity checks covered by `resolve-approval-identity.test.ts`.

### Testing Requirements

- `resolve-tool.test.ts`, `resolve-approval-identity.test.ts`

### Common Patterns

- Stage in producer tool → model calls `resolve` → registry slot consumed exactly once

## Dependencies

### Internal

- `../staged-preview-registry.ts`
- Parent tool registry / permission callbacks
- `@mission-control/protocol` for tool I/O shapes as needed

### External

- Zod

<!-- MANUAL: -->
