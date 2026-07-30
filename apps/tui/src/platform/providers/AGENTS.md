<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# providers

## Purpose

Solid provider composition root for the interactive TUI. `MissionControlTuiProviders` wires runtime, paths/config, runtime events, project/session sync, route/dialog/theme, local preferences, prompt history/services, clipboard/toast, keymap, chat session context, and descriptor-first plugin runtime. Exported only via `@mission-control/tui/providers`.

## Key Files

| File | Description |
|------|-------------|
| `index.tsx` | `MissionControlTuiProviders` composition root |
| `context-base.tsx` | Shared context primitives |
| `runtime-context.tsx` | Runtime structural services context |
| `runtime-events-context.tsx` | Runtime event subscription context |
| `chat-session-context.tsx` | Active chat session context |
| `project-sync-context.tsx` | Project/session replay sync projection |
| `route-dialog-theme-context.tsx` | Route, dialog stack, theme |
| `local-preferences-context.tsx` | Local UI preferences |
| `prompt-history-context.tsx` | Prompt history store bridge |
| `prompt-services-context.tsx` | Prompt services (stash/frecency-style) |
| `clipboard-toast-context.tsx` | Clipboard + toast services |
| `plugin-runtime-context.tsx` | Plugin host provider |
| `plugin-runtime-service.ts` | Descriptor-first plugin runtime service |
| `plugin-runtime-types.ts` | Plugin capability/descriptor types |
| `plugin-runtime-test-support.ts` | Plugin test doubles |
| `provider-root.test.tsx` | Root composition tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Do not export providers from `src/index.ts` — dedicated `./providers` subpath only.
- Components consume hooks/services; they must not construct `AgentRuntime`, provider adapters, tool registries, or CLI action classes.
- Persistence paths come from `TuiPathsProviderValue` (`dataDir`, `configDir`, workspace) selecting `packages/core/src/tui-stores/`.
- Plugin runtime is descriptor-first: trusted manifests register allowed slots/routes/commands/KV/dialog/theme; denied caps → redacted diagnostics; project-local descriptors inert until workspace trust; cleanup disposes registrations.

### Testing Requirements
- Colocated `*-context.test.tsx` and plugin-runtime capability/failure tests.
- `provider-root.test.tsx` pins composition order/surface.

### Common Patterns
- Provider value objects are structural interfaces injected at mount.
- Test support modules avoid loading real native renderer.

## Dependencies

### Internal
- `packages/core/src/tui-stores/` — preference/history/persistence stores
- `../keymap` — keymap provider nested in root
- `../../state` — types only where needed
- Mounted from `create-chat-tui.tsx`

### External
- `solid-js`, `@opentui/solid`, `@opentui/keymap`

<!-- MANUAL: -->
