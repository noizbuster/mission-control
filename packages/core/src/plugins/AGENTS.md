<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# plugins

## Purpose

Plugin discovery and management: resolve plugin home/dirs, discover manifests under size/count caps, `PluginManager` orchestration (eager MCP configs, lazy categories/modes/tools/nodes/context/subagents/lsp), and TUI plugin host registry for UI plugin load/registration.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public exports |
| `plugin-paths.ts` | `resolvePluginHome`, `resolvePluginDir`, `ensurePluginDirs`, env key |
| `plugin-loader.ts` | `discoverPlugins`, `loadPluginManifest`, size/count defaults |
| `plugin-manager.ts` | `PluginManager` — initialize + lazy `load*()` + dir getters for other discoverers |
| `tui-plugin-host.ts` | `TuiPluginHostRegistry` load/registration API |
| `*.test.ts` | manager/loader/host/integration tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Manager **collects** paths/content; it does not replace skills/workflows discovery — callers pass `getSkillDirs()` / `getWorkflowDirs()` into those loaders.
- Pre-load MCP configs on `initialize()` (sync `getMcpConfigs()` need); lazy-load everything else.
- Enforce `DEFAULT_MAX_PLUGIN_FILE_BYTES` / `DEFAULT_MAX_PLUGINS`.
- Use shared discovery JSONC/denylist helpers from `../discovery/` where applicable.
- TUI host is separate from core manager — keep UI sandbox concerns in `tui-plugin-host`.

### Testing Requirements

- `plugin-manager.test.ts`, `plugin-integration.test.ts`, `tui-plugin-host.test.ts`

### Common Patterns

- discover → manager.initialize → consumers query dirs/content
- Never-throw discovery with diagnostics (mirrors workflows/skills)

## Dependencies

### Internal

- `../discovery/` JSONC + walker primitives
- Skills/workflows loaders as downstream consumers of plugin dirs
- MCP config consumers in tools/mcp
- `@mission-control/protocol` / config as needed

### External

- Node fs; dynamic import for TUI plugin modules where hosted

<!-- MANUAL: -->
