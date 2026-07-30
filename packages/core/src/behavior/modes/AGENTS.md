<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# modes

## Purpose

Structural mode overlays applied at graph materialization time — **not** free-form prompt injection alone. `applyMode` produces a new `AbgGraphSpec` with system-prompt overlays, converted policy-gate rules, and optional required-tools capability intersection. Includes the builtin `autopilot` mode declaration.

## Key Files

| File | Description |
|------|-------------|
| `mode-application.ts` | Pure `applyMode(mode, graph)` — overlay / policies / requiredTools transforms |
| `mode-application.test.ts` | Overlay prepend, policy conversion, capability intersect, immutability |
| `autopilot-mode.ts` | `AUTOPILOT_MODE_ID`, `autopilot` `Mode` declaration + principle overlay |
| `autopilot-e2e.test.ts` | End-to-end autopilot materialization behavior |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Modes are structural overlays at materialize time, not runtime mutators of a live graph.
- `applyMode` never mutates the input graph — always returns a new spec.
- Three transforms only:
  1. Prepend `systemPromptOverlay` to every `llm` node's `config.systemPrompt`
  2. Convert `mode.policies` (`PolicyEffectRule`) → `AbgPolicySpec` appended to `graph.policies`
  3. Intersect node `capabilities` with `mode.requiredTools` when non-empty
- `'ask'` effect maps to `'requires_approval'` (conservative).
- Policy id namespaced `{modeId}:policy:{index}`; resource glob preserved in `reason`.
- Soft directives (file-count reviewer rules, test-deletion bans) stay in overlay text when the policy algebra cannot express them — do not fake hard rules.
- Autopilot: empty `requiredTools`; hard rule edit→ask (scenario-before-edit); overlay carries seven invariants.

### Testing Requirements

- `mode-application.test.ts`, `autopilot-e2e.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/modes/<file>.test.ts`

### Common Patterns

- Planner-readonly mode may use empty `requiredTools` so materialize does not strip `subagent`/`network`/`bash` from explore/research; write-deny policies still govern mutations.
- Keep `PolicyEffectRule` and workspace `PermissionRule` vocabularies distinct.

## Dependencies

### Internal

- `@mission-control/protocol` — `Mode`, `AbgGraphSpec`, `PolicyEffectRule`, `AbgPolicySpec`
- Workflow materialization callers in `../` and `../runtime/mission-run/`

### External

- None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
