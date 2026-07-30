<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# tests

## Purpose

Root workspace contract and integration tests. Locks README language, workflow YAML, Nx project graph, package export surfaces, CLI/TUI boundaries, native artifacts, storage layout guards, profile guardrails, and coding-agent session-store e2e behavior. Package/app unit tests stay colocated; this tree is cross-cutting and documentation/contract oriented.

## Key Files

| File | Description |
|------|-------------|
| `workspace-structure.test.ts` | Workspace layout / required paths |
| `workspace-build.test.ts` | Build graph expectations |
| `nx-workspace.test.ts` | Nx project/target contracts |
| `nx-workspace-test-support.ts` | Helpers for Nx workspace assertions |
| `protocol-export.test.ts` | Public `@mission-control/protocol` export surface |
| `workflow-yaml.test.ts` | CI/release workflow YAML contracts |
| `readme-contract.test.ts` | Core README locked phrases |
| `readme-runtime-contract.test.ts` | Runtime/README alignment |
| `readme-configuration.test.ts` | Configuration docs contract |
| `readme-distribution.test.ts` | Distribution/artifact naming docs |
| `readme-extension-points.test.ts` | Extension-point docs |
| `readme-abg.test.ts` | ABG README mentions |
| `readme-desktop-tool-contract.test.ts` | Desktop tool docs |
| `abg-root.test.ts` | Root ABG.md presence/contract |
| `abg-boundary.test.ts` | ABG boundary / scaffold limits |
| `native-artifact-contract.test.ts` | Sidecar/natives artifact layout |
| `storage-artifact-guard.test.ts` | Forbids committing storage/generated junk |
| `profile-guardrails.test.ts` | Config profile path/behavior guardrails |
| `tui-cli-boundary.test.ts` | CLI↔TUI package boundary |
| `tui-solid-deps.test.ts` | Solid dependency pins for TUI |
| `tui-provider-architecture-docs.test.ts` | TUI provider architecture docs |
| `cli-integration.test.ts` | CLI integration |
| `cli-built-no-ffi.test.ts` | Built CLI without FFI path |
| `cli-built-tui-transient-notice.test.ts` | TUI transient notice in built CLI |
| `cli-custom-workflow-tool-call-id.test.ts` | Custom workflow tool call id |
| `cli-local-db-concurrency.test.ts` | Local DB concurrency |
| `coding-agent-session-store-e2e.test.ts` | Session store e2e |
| `coding-agent-session-store-e2e-*.ts` | E2E support/events/task helpers |
| `coding-agent-smoke-*.ts` | Smoke fixtures/support shared with scripts |
| `contract-agent-system.test.ts` | Agent system contracts |
| `core-file-write-arguments-budget.test.ts` | file.write argument budget |
| `changed-typescript-size.test.ts` | Size-check script contract |
| `extensionless-relative-imports.test.ts` | Import path style guard |
| `module-specifier-boundary.ts` | Specifier boundary helper |
| `no-any.test.ts` | Bans `any` / escape hatches in source |
| `vitest-export-alias-parity.test.ts` | Vitest alias ↔ package exports parity |
| `read-output-stability.test.ts` | Read-output stability |
| `session-stop-owner-fixture.test.ts` | Session stop owner fixture |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fixtures/` | Preloads and session-stop-owner support modules for root tests (skip inventing new fixture trees unless needed) |

## For AI Agents

### Working In This Directory
- These tests are the tripwire for README/docs/workspace drift. Update the test **and** the doc/code together when changing locked language or layout.
- Do not move package unit tests here; keep those colocated under `packages/*` and `apps/*`.
- Prefer deterministic, no-network tests. E2E/session tests use temp data dirs and local libSQL only.
- `no-any.test.ts` and storage/native guards enforce repo-wide policy — fix sources, do not weaken without explicit intent.
- Support files (`*-support.ts`, `*-fixtures.ts`) are not standalone tests.

### Testing Requirements
- Run via root: `pnpm test` (Nx `run-many -t test`) or `pnpm exec vitest run tests/<file>.test.ts`
- Config: root `vitest.config.ts` (Solid plugin scoped to `apps/tui`, package source aliases)
- Avoid running the entire monorepo suite for a one-line doc fix; target the specific contract file.

### Common Patterns
- Vitest `expect` + `readFile`/`readdir` against repo paths
- Regex/string locks on README and workflow YAML
- Temp directories for CLI/session e2e; always clean up
- Shared helpers imported from sibling `*-support.ts` files

## Dependencies

### Internal
- Workspace packages via Vitest aliases (`@mission-control/*` → source)
- Nx/project.json graph, `.github/workflows`, root README/ABG.md
- Scripts under `scripts/` for size/packaging contracts
- Fixtures may preload CLI local-db paths

### External
- Vitest, Node test runtime; no extra prod deps

<!-- MANUAL: -->
