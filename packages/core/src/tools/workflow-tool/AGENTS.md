<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# workflow-tool

## Purpose

`workflow` tool: model self-invokes a named workflow by name + prompt. Resolves via injected `WorkflowRegistry`, returns status (including helpful `not_found` with available names). Does **not** execute the graph — runtime adapter routes `spec.graph` through prompt-turn lifecycle. Capability `'workflow'` is hard-dropped on child surfaces.

## Key Files

| File | Description |
|------|-------------|
| `workflow-tool.ts` | `createWorkflowToolRegistration` / `registerWorkflowTool`, schemas |
| `workflow-tool.test.ts` | Resolve/not_found/registration behavior |

Parent e2e: `../workflow-tool-e2e.test.ts`.

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Thin contract only: validate → resolve name → return. Never run a real graph here.
- `not_found` is a returned status (not thrown) so the model can retry with corrected name.
- Mirror skill-tool name-lookup UX (list available names on miss).
- Children must not receive this tool (`workflow` hard-drop).

### Testing Requirements

- `workflow-tool.test.ts`; broader path `../workflow-tool-e2e.test.ts`

### Common Patterns

- Inject `WorkflowRegistry` from `../../workflows/`
- Capability class `'workflow'`

## Dependencies

### Internal

- `../../workflows/` — `WorkflowRegistry`, discovery/materialize
- Parent tool registry
- `@mission-control/protocol` workflow shapes as applicable

### External

- Zod

<!-- MANUAL: -->
