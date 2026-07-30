<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# discovery

## Purpose

Shared resource-discovery primitives for skills/workflows/plugins: automated-discovery denylist matching, bounded directory walkers, and never-throw JSONC load pipeline (stat → size cap → strip comments → parse → schema validate).

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Denylist helpers, re-exports walker + `resolveUserConfigDir` |
| `resource-walker.ts` | `walkResourceFiles`, `manifestDenylistDirNames` |
| `load-jsonc.ts` | `loadJsoncResource`, `jsoncDiagnosticFields`, staged failure outcomes |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Never-throws loaders: failures become diagnostics/outcomes, not exceptions (unless a caller explicitly chooses otherwise).
- Reuse denylist needles from `../tools/read-tools-paths` (`defaultAutomatedDiscoveryDenylist`).
- Callers supply schema + diagnostic factory so workflow vs plugin wording stays local.
- Symlink/escape defenses belong in the walker options — preserve them.

### Testing Requirements

- Exercised via `../workflows/workflow-loader.test.ts`, `../plugins/*`, skills loader tests; add local tests if logic grows

### Common Patterns

- denylist → walk → `loadJsoncResource` → collect diagnostics

## Dependencies

### Internal

- `../tools/read-tools-paths.ts` — denylist + posix path helpers
- `../skills/skill-loader.ts` — `resolveUserConfigDir` re-export
- Consumers: workflows, plugins, skills

### External

- Zod (caller schemas), JSONC strip utilities as used in `load-jsonc.ts`

<!-- MANUAL: -->
