<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# abg

## Purpose

Authorable ABG graph and workflow fixtures: golden `*.workflow.json` graphs kept byte-identical to core factory builders, smaller `*.graph.json` scenarios (valid + intentionally invalid), and a documented `*.workflow.jsonc` plugin-authoring sample. Consumed by parity/e2e tests under `packages/core` and CLI workflow paths.

## Key Files

| File | Description |
|------|-------------|
| `default.workflow.json` | Plain-prompt fallback workflow; parity with `createDefaultWorkflowGraph` |
| `planner.workflow.json` | Deep planning craft; parity with `createPlannerWorkflowGraph` |
| `executer.workflow.json` | Plan execution conductor (admit → delegate → verify); parity with executer factory |
| `fixer.workflow.json` | Intent-gated implement/fix path; parity with fixer factory |
| `custom-example.workflow.jsonc` | Documented full optional-block sample for `docs/plugin-authoring.md` (JSONC comments) |
| `coding-agent.graph.json` | Approved coding-agent graph fixture for run/replay tests |
| `coding-agent-denied.graph.json` | Coding-agent variant with denied capabilities |
| `parallel-race.graph.json` | `parallel` children + race-oriented structure sample |
| `policy-block.graph.json` | Policy deny on `filesystem.write` |
| `research-answer.graph.json` | Minimal llm → action success path |
| `malformed-edge.graph.json` | Intentionally invalid edge to missing target (negative fixture) |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- Golden workflows (`default` / `planner` / `executer` / `fixer`): change the TypeScript factory first, then refresh the JSON so `toEqual` parity tests stay green (`packages/core/src/behavior/*-workflow-graph.ts` + `*-parity.test.ts` / `abg-reference-parity.test.ts`).
- Validate workflows with `WorkflowSpecSchema`; graphs with `AbgGraphSpecSchema` / `createAuthorableAbgGraph`.
- Keep negative fixtures deliberately invalid — do not "fix" `malformed-edge.graph.json`.
- `custom-example.workflow.jsonc` is docs-oriented; copy guidance targets user discovery scopes (e.g. `.mctrl/workflows`), not this directory at runtime.
- Autopilot is a **mode overlay**, not a graph file here.

### Testing Requirements
- Core: `abg-reference-parity.test.ts`, `*-workflow-graph.test.ts`, `*-parity.test.ts`, `coding-agent-graph-fixtures.test.ts`, planner/executer e2e tests, `workflow-tool-e2e.test.ts`.
- No package-local test runner in this folder.

### Common Patterns
- Workflow files: top-level `{ name, description, graph }`.
- Graph files: `{ id, version?, entryNodeId, nodes, edges, rules, policies, … }`.
- Factory ↔ fixture byte identity is locked; drive edits from code generators/factories when possible.

## Dependencies

### Internal
- `packages/protocol` — `WorkflowSpecSchema`, `AbgGraphSpecSchema`
- `packages/core/src/behavior/*-workflow-graph.ts` — factories
- `packages/core/src/workflows/materialize-workflow.ts` — mode materialization
- `docs/plugin-authoring.md` — custom-example narrative

### External
- None (static JSON/JSONC fixtures)

<!-- MANUAL: -->
