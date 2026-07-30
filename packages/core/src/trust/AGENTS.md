<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# trust

## Purpose

Project trust store and decision resolution for workspace roots (`trusted` / untrusted / unknown). Gates project-scoped MCP config merge and live MCP invocation revalidation.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Re-exports store + decision helpers |
| `project-trust-store.ts` | `ProjectTrustStore`, `resolveProjectTrustDecision`, `normalizeWorkspaceRoot`, decision enums |
| `project-trust-store.test.ts` | Persist/lookup/normalize coverage |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Normalize workspace roots before read/write — stable keys across path variants.
- MCP and other project-scoped features must re-read canonical trust at use time (see `../tools/mcp/`).
- Fail closed on lookup errors when a feature requires `trusted`.
- Keep decision vocabulary stable (`projectTrustDecisions`).

### Testing Requirements

- `project-trust-store.test.ts`
- Integration coverage also in `../tools/mcp/project-trust-*.test.ts`

### Common Patterns

- normalize root → lookup decision → gate feature

## Dependencies

### Internal

- Consumers: `../tools/mcp/`, context loaders, CLI trust UX
- Persistence path for store file (as implemented in `project-trust-store.ts`)

### External

- Zod for persisted shape validation

<!-- MANUAL: -->
