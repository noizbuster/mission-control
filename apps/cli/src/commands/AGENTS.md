<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# commands

## Purpose

CLI command and interactive-session orchestration: `run-agent` modes, interactive chat loop, coding-agent transcript projection, approval broker, auth/session/MCP/models/agents subcommands, production tool registry registration, workflow materialization/resume, and mission-control services.

## Key Files

| File | Description |
|------|-------------|
| `run-agent.ts` | Top run orchestration: chat vs noninteractive, provider setup, permissions, workspace root |
| `run-agent-interactive.ts` | Interactive path wiring |
| `run-agent-noninteractive.ts` | `--no-tui` / `--json` / `--jsonl` path |
| `run-agent-session.ts` | Session store creation; `'tui'` mode included so graph+tools path always used |
| `run-agent-graph.ts` / `run-agent-graph-prompt.ts` | Graph load and prompt path |
| `run-agent-workflow.ts` / `run-agent-workflow-run.ts` | Noninteractive `--workflow` and workflow run lifecycle |
| `run-agent-model-selection.ts` | Provider/model/variant selection |
| `run-agent-workspace.ts` | `resolveWorkspaceRoot` / `detectWorkspaceRoot` |
| `run-agent-options.ts` / `run-agent-mode.ts` / `run-agent-rendering.ts` | Shared run options, mode, renderer selection |
| `run-agent-owner-prompt.ts` | Owner-prompt / task-services attachment |
| `interactive-chat.ts` | Main interactive loop; lazy-loads `@mission-control/tui/create-chat-tui` |
| `interactive-chat-actions.ts` | CLI side-effect adapters injected as `ChatAppActions` |
| `interactive-chat-io.ts` | `ChatOutput` extensions; re-exports `ChatInputEvent` from TUI state |
| `interactive-chat-prompt-turn.ts` | Prompt-turn execution; provider failure → `Error: ` output |
| `interactive-chat-command.ts` / `chat-commands.ts` | Slash/`#workflow`/`$skill`/`!bash` line parse → actions |
| `store-chat-output.ts` | `ChatStore` → `ChatOutput` adapter (16ms coalescing stays store-side) |
| `interactive-coding-agent.ts` | Coding-agent turn runner + settlement |
| `interactive-coding-tools.ts` | Interactive tool surface construction |
| `interactive-coding-run-settlement.ts` | Run settlement + sanitization |
| `interactive-coding-tool-preview.ts` / `interactive-coding-file-write-preview.ts` | Tool/file write previews |
| `interactive-transcript-emission.ts` | Typed transcript part emission into TUI store |
| `interactive-approval-broker.ts` | Approval request/settle broker for interactive tools |
| `interactive-workflow-state.ts` / `interactive-workflow-actions.ts` / `interactive-workflow-resume-actions.ts` | Workflow UI state and resume |
| `workflow-materialization.ts` | CLI seam → `materializeWorkflow` / default fallback graphs |
| `mission-control-services.ts` | Session-owned lifecycle/job/registry manager for TUI |
| `production-tool-registry.ts` / `register-default-coding-tools.ts` / `register-default-orchestration-tools.ts` / `register-default-configured-tools.ts` | Production tool registration |
| `noninteractive-tool-registry.ts` | Headless tool registry |
| `provider-factory.ts` | Capability → provider adapter |
| `model-discovery.ts` / `models.ts` | Live model discovery + `mc models` |
| `auth.ts` / `auth-oauth*.ts` / `auth-login-*.ts` / `auth-prompts.ts` | Auth login/logout/OAuth (`mc auth`) |
| `auth-command.ts` / `interactive-chat-auth-action.ts` | `/auth login|list|logout` slash parse + action (reuses `runAuthCommand`; not palette) |
| `session.ts` / `session-catalog.ts` / `session-archive.ts` / `session-delete-command.ts` / `session-stop-command.ts` | Session CLI surface |
| `session-attach-projection.ts` / `session-transcript-reconstruction.ts` | Attach/replay projections |
| `mcp.ts` / `mcp-display.ts` | MCP list/test/add/remove |
| `agents-command.ts` / `agents-cli.ts` / `agents-disabled-config.ts` / `agents-model-overrides-config.ts` | Agents list/disable/model override |
| `cli-permission-policy.ts` / `cli-trust.ts` / `cli-runtime-options.ts` | Permission, trust, runtime flags |
| `coding-agent-context.ts` | Coding-agent context assembly |
| `local-coding-provider.ts` | Deterministic local/echo provider for demos/tests |
| `welcome-data.ts` | Welcome panel data (`cli-version` + session catalog) |
| `input-history-store.ts` / `approval-level-store.ts` / `pricing-table-store.ts` | CLI-side durable small stores |
| `terminal-controls.ts` | Non-TUI terminal control helpers |
| `graph-observability-redactor.ts` | Graph observability redaction |
| `work-resume-decision.ts` | Resume/blocked-work decision helper |
| `git-workspace.ts` | Git workspace detection helpers |
| `lsp-tool-registration.ts` | LSP tool registration bridge |

## Subdirectories

_None — flat command module directory (very large; colocated `*.test.ts`)._

## For AI Agents

### Working In This Directory
- Interactive path owns the loop; TUI owns rendering. Mutate chat UI only through `ChatTuiHandle` / store APIs exposed by TUI, not by reaching into Solid components.
- Provider errors: catch at prompt-turn, coding-agent `settleReceipt`, and main-loop `try-catch` (see package AGENTS Error Handling).
- `#name {prompt}` → `parseWorkflowInvocation` + `runWorkflowAction`; `--workflow` mutually exclusive with `--graph`.
- `$skill` loads SKILL.md body as inert text; `!cmd` / `!!cmd` need workspace trust.
- Do not bypass `createAllowPermissionDecision` / approval broker for write-capable paths.
- Do not add shell-string command execution.
- Keep non-TUI terminal fallback — integration tests inject scripted IO.

### Testing Requirements
- Huge colocated surface: `run-agent-*.test.ts`, `interactive-*.test.ts`, `session-*.test.ts`, `workflow-*-e2e.test.ts`, tool-registration matrix tests.
- Prefer focused vitest file runs; full `nx run cli:test` is heavy.
- E2E workflow tests use `workflow-e2e-test-support.ts`.

### Common Patterns
- File clusters by prefix: `run-agent-*`, `interactive-chat-*`, `interactive-coding-*`, `session-*`, `auth-*`, `default-*-tool-registration*`.
- `*-test-support.ts` = shared fixtures; do not import from production entrypoints into support in ways that load OpenTUI.
- Transcript identity: occurrence-scoped IDs; redaction before emission.

## Dependencies

### Internal
- `apps/tui` — `create-chat-tui`, `replay-overlay`, state types (lazy/type-only)
- `packages/core` — `AgentRuntime`, tools, workflows, agents, permissions, persistence
- `packages/protocol` — events, workflow, agent, permission schemas
- `packages/config` — models catalog / variants
- `../ui` — noninteractive renderers
- `../cli-version.ts`, `../args` family

### External
- None direct beyond workspace packages

<!-- MANUAL: -->
