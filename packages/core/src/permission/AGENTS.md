<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# permission

## Purpose

Session-scoped permission authority: rule store, session remember/always replies, request evaluation, and workspace-root normalization. Default decisions stay conservative (deny-by-default at higher layers via `createDefaultPermissionDecision`).

## Key Files

| File | Description |
|------|-------------|
| `store.ts` | `PermissionRuleStore` — append/load persisted rules |
| `session.ts` | `PermissionSession` — baseline tiers, remember replies, authority commit |
| `evaluator.ts` | `evaluatePermissionRequest` |
| `workspace-root.ts` | Normalize workspace root, rules, and requests |
| `glob.ts` | Glob helpers for rule matching |
| `*.test.ts` | Session, store commit, authority commit coverage |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Session "always" replies and persisted rules survive baseline tier swaps.
- Normalize paths/roots before evaluate/store — prevent bypass via path forms.
- Authority commit cancellation is a first-class error (`PermissionAuthorityCommitCancelledError`).
- Distinct from `../permissions/` (policy-gate wildcard evaluator used elsewhere); do not merge casually.
- Effectful tools must still call into this authority — advertising ≠ authorization.

### Testing Requirements

- `session.test.ts`, `store-commit.test.ts`, `session-authority-commit.test.ts`

### Common Patterns

- normalize → evaluate → optional remember/persist → commit

## Dependencies

### Internal

- `@mission-control/protocol` — `PermissionRule` schemas
- Consumers: tools, runtime approval gates, desktop approvals
- Sibling `../permissions/` for lower-level wildcard matching where used

### External

- Zod via protocol schemas

<!-- MANUAL: -->
