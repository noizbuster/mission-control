<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# workflows

## Purpose

Workflow discovery and registry: load `*.workflow.json(c)` across three scopes (first-wins by name), materialize default/spec lookup, in-memory `WorkflowRegistry`, and shared JSONC parse helper. Never-throws discovery with diagnostics.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public exports (discover, materialize, registry) |
| `workflow-loader.ts` | `discoverWorkflows` — 3-scope walk, denylist, size/count caps |
| `workflow-registry.ts` | `WorkflowRegistry` in-memory index |
| `materialize-workflow.ts` | `materializeWorkflow`, `resolveDefaultWorkflowSpec`, default name |
| `jsonc-parser.ts` | JSONC parse helper for workflow files |
| `*.test.ts` | loader/registry coverage |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Scope priority (first-wins by name):
  1. global `<user-config-dir>/workflows/`
  2. project `<workspace>/.mctrl/workflows/`
  3. project `<workspace>/.agents/workflows/`
- Broken workflows → diagnostics, never throw from discover.
- Enforce `DEFAULT_MAX_WORKFLOW_FILE_BYTES` / `DEFAULT_MAX_WORKFLOWS`.
- Symlink/denylist defenses shared with skills via `../discovery/` and read-tools denylist.
- `../tools/workflow-tool/` resolves names through `WorkflowRegistry` only — graph execution is runtime-side.
- Plugin manager may inject extra workflow dirs via `getWorkflowDirs()`.

### Testing Requirements

- `workflow-loader.test.ts`, `workflow-registry.test.ts`

### Common Patterns

- discover → registry populate → materialize/lookup by name
- Mirror `discoverSkills` structure for consistency

## Dependencies

### Internal

- `../discovery/` walker + JSONC load primitives
- `../skills/skill-loader` user config dir
- `../tools/workflow-tool/` consumer
- `../behavior/` graph specs once materialized
- `@mission-control/protocol` workflow schema types

### External

- Zod / JSONC as used by loader

<!-- MANUAL: -->
