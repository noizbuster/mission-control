<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# permissions

## Purpose

Policy-gate permission primitives: segment-aware glob wildcard matching and ordered rule evaluation (`allow`/`deny`/`ask` style results). Used by higher-level permission sessions and tool policy checks. Sibling of `../permission/` (session store/authority).

## Key Files

| File | Description |
|------|-------------|
| `wildcard-match.ts` | `wildcardMatch` — `*` segment-local, `**` multi-segment, `?` single char |
| `rule-evaluator.ts` | `evaluateRules` / `EvaluationResult` |
| `permissions.test.ts` | Wildcard + evaluator coverage |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- `*` must not cross `/`; `**` spans segments — do not regress to naive `.*` semantics.
- Keep regex cache test hooks (`_testRegexCacheSize`, `_testResetRegexCache`) for deterministic tests.
- Parent package also exports `../permissions.ts` facade — keep behavior aligned.
- Prefer this matcher for policy paths; session authority UX lives in `../permission/`.

### Testing Requirements

- `permissions.test.ts`

### Common Patterns

- Evaluate rules in order; first decisive match wins (per evaluator contract)

## Dependencies

### Internal

- `../permission/` session layer may compose these primitives
- Protocol permission rule shapes at call sites

### External

- None

<!-- MANUAL: -->
