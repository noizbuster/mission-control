<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# examples

## Purpose

Checked-in fixtures for authorable behavior graphs/workflows and plan markdown shape. Built-in workflow JSON under `abg/` is kept byte-identity-aligned with factory graphs in `packages/core/src/behavior/`. Plan examples demonstrate the checklist headings `parsePlanChecklistText` counts.

## Key Files

No files at this directory root.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `abg/` | Valid + intentionally invalid graph/workflow fixtures (see `abg/AGENTS.md`) |
| `plans/` | Example plan markdown for checklist/admission parity (see `plans/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Built-in workflows: `default`, `planner`, `executer`, `fixer` (plus graph-only fixtures and `custom-example.workflow.jsonc`).
- Factory parity: `examples/abg/{default,planner,runner,...}` graphs ↔ `packages/core/src/behavior/*-workflow-graph.ts` — locked by `toEqual` tests; edit both sides together.
- Invalid fixtures (`malformed-edge`, `policy-block`, denied coding-agent) exist for negative loader/runtime tests — do not "fix" them into valid graphs.
- Plan example uses column-0 checkboxes under `## TODOs` and `## Final Verification Wave` only.

### Testing Requirements
- Core behavior/workflow tests and `packages/core/src/behavior/abg-reference-parity.test.ts`
- Root `tests/abg-boundary.test.ts`, `tests/abg-root.test.ts`
- No Nx project for `examples/` itself

### Common Patterns
- `*.workflow.json` / `*.workflow.jsonc` validated by `WorkflowSpecSchema` (strict top-level; JSONC comments stripped)
- `*.graph.json` are raw `AbgGraphSpec` fixtures without workflow envelope
- Discovery scopes in production are config/project dirs; these paths are repo fixtures and doc references

## Dependencies

### Internal
- Schemas: `packages/protocol` (`AbgGraphSpecSchema`, `WorkflowSpecSchema`)
- Factories/runtime: `packages/core/src/behavior/`, `packages/core/src/workflows/`
- Docs: `docs/plugin-authoring.md`, `docs/abg-reference-parity-matrix.md`

### External
- None

<!-- MANUAL: -->
