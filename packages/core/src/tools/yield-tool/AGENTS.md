<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# yield-tool

## Purpose

`yield` tool for child-agent final result submission. Validates `result` against the agent's optional `output` schema and returns stop-now confirmation. Runtime (`ConcreteTaskToolRuntime`) emits `YieldSignal` to terminate the child loop — this tool validates/returns only. Capability `'yield'` is intentionally retained on children (terminating capability).

## Key Files

| File | Description |
|------|-------------|
| `yield-tool.ts` | `createYieldToolRegistration`, input/output schemas |
| `yield-tool.test.ts` | Schema validation and registration behavior |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Do not emit yield signals or stop the session from the tool body — runtime owns termination.
- Optional `findings[]` accepted at input boundary; runtime splices into parent findings (tool does not merge).
- Keep `'yield'` out of child hard-drop sets.
- Validate against `AgentDefinition.output` when present; fail closed on schema mismatch.

### Testing Requirements

- `yield-tool.test.ts`

### Common Patterns

- Injected schema from agent definition; capability class `'yield'`
- Symmetric with task tool's child completion path

## Dependencies

### Internal

- `../../agents/` task runtime (signal emission, findings merge)
- `../../behavior/subagents/` child policy (must keep yield)
- Parent tool registry
- `@mission-control/protocol`

### External

- Zod

<!-- MANUAL: -->
