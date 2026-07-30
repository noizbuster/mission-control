<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# test-support

## Purpose

Package-level Vitest shims for `@mission-control/tui` tests that need lightweight stand-ins for core modules without booting full runtime/native stacks.

## Key Files

| File | Description |
|------|-------------|
| `core-test-shim.ts` | Core import shim used by TUI vitest config/tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Keep shims minimal and test-only; never import from production CLI entrypoints.
- Prefer expanding shims here over scattering mocks inside component files.

### Testing Requirements
- Exercised indirectly by `tui:test` / vitest config.

### Common Patterns
- Explicit named exports matching the subset of core APIs tests touch.

## Dependencies

### Internal
- Referenced by `apps/tui/vite.config.ts` / test setup

### External
- Vitest (workspace)

<!-- MANUAL: -->
