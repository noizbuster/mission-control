<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# providers

## Purpose

Nine cross-harness agent importers. Each scans foreign harness directories and returns `AgentDefinition` objects via `AgentPluginProvider`. `registerBuiltinProviders` wires all nine into a `CapabilityRegistry` at priority 50 so mission-control builtin agents (priority 100) win name conflicts.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `CROSS_HARNESS_PROVIDERS`, `registerBuiltinProviders` |
| `scan-agent-dir.ts` | Shared directory walker for agent markdown files |
| `_claude-compatible.ts` | Shared frontmatter conversion base (Claude Code + Cursor) |
| `claude-provider.ts` | Claude Code agent importer |
| `cursor-provider.ts` | Cursor agent importer |
| `codex-provider.ts` | Codex agent importer |
| `gemini-provider.ts` | Gemini agent importer |
| `cline-provider.ts` | Cline agent importer |
| `windsurf-provider.ts` | Windsurf agent importer |
| `vscode-provider.ts` | VS Code agent importer |
| `github-copilot-provider.ts` | GitHub Copilot agent importer |
| `opencode-provider.ts` | OpenCode agent importer |
| `*.test.ts` | Per-provider scan/conversion tests + `index.test.ts` |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- All providers implement `AgentPluginProvider` from `../capability/types.ts`.
- Prefer `scan-agent-dir.ts` for directory walking; do not fork ad-hoc scanners.
- Claude-compatible harnesses should extend `_claude-compatible.ts` conversion.
- Never raise provider priority above the builtin 100 scope loader.
- Malformed foreign files → diagnostics, skip; do not throw out of `loadAgents`.
- Output must be fully validated `AgentDefinition` objects (parse through shared schema path).

### Testing Requirements

- One `*-provider.test.ts` per importer + `index.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/agents/providers/<file>.test.ts`

### Common Patterns

- Provider id/displayName stable strings used in diagnostics (`provider_error`, shadowing messages).
- Directory roots come from `LoadContext` (user home, workspace, harness-specific config paths).

## Dependencies

### Internal

- `../capability/` — registry + provider types
- `../agent-parser.ts` — optional parse helpers depending on harness
- `@mission-control/protocol` — `AgentDefinition`

### External

- Node `fs`/`path` for harness directory scans

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
