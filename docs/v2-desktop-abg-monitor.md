# ABG Monitor — Desktop Integration Design (v2 scaffold)

**Status:** Scaffold — implementation deferred to v3. This document captures the design path so the next iteration can execute without re-investigation.

## Goal

Bring the ABG overlay (currently CLI Ink-only) to the desktop app as a live observation surface, alongside the existing Timeline/Graph/Session views.

## Current State (post-v2)

The CLI Ink overlay (`apps/cli/src/components/AbgOverlay.tsx`) consumes `AbgOverlayState` projected from `AbgSignal` + `AgentEvent` streams. The projector (`apps/cli/src/commands/abg-overlay-state.ts`) is pure: feed it signals/events, get a state shape back. This is reusable.

The desktop (`apps/desktop/`) currently:
- Reads durable local DB sessions through the desktop command bridge and replay projection helpers
- Renders Timeline/Graph/Session views from the projected snapshot
- Uses a **reload-after-write** model — there is no live event stream today

## Integration Path

### Phase 1 — Projector reuse (low effort)

Move `AbgOverlayState` and the pure projectors (`projectAbgSignal`, `projectAgentEvent`, `mergeGraphSnapshot`, `extractBudgetPayload`, `extractBlackboardMutation`) from `apps/cli/src/commands/abg-overlay-state.ts` to a new `packages/core/src/abg-overlay/` module. Re-export from `@mission-control/core`. CLI imports unchanged (just path). Desktop imports the same projectors.

### Phase 2 — Live event stream (medium effort)

The desktop needs live events. Three options, ranked by implementation cost:

1. **Tauri event bridge** — Add a Tauri command `subscribe_session_events(sessionId)` that emits `tauri::Window::emit` for each new event appended to the local session database. The bridge can poll a session sequence cursor through the existing command service until a native notification path exists. The desktop React layer subscribes via `listen()` from `@tauri-apps/api/event`.
2. **DB cursor polling** — Node-side polling of new session envelopes by sequence through the command bridge; on change, dispatch newly observed envelopes.
3. **WebSocket from core** — Core opens a WebSocket server when a run starts; desktop connects and consumes the live event stream.

Option 1 is the cleanest (no file watcher, no port management) and matches Tauri's command bridge pattern.

### Phase 3 — React components (low-medium effort)

The Ink components (`AbgOverlay.tsx`, `AbgOverlayPanesA.tsx`, `AbgOverlayPanesB.tsx`) use `<Box>`/`<Text>` from `ink`. The desktop uses `<div>`/`<span>` with CSS. Two paths:

1. **Adapter layer** — Wrap Ink primitives in a `ink-to-dom` adapter so the same JSX renders to web. Heavy work; only worth it if many Ink components are shared.
2. **Parallel component tree** — Re-implement the panes as React DOM components (matching the existing `SessionInspectorDetailPanels.tsx` pattern). Simpler; no shared render layer.

Option 2 fits the existing desktop architecture. The projectors are shared (Phase 1), but the components are parallel.

### Phase 4 — Cursor and keyboard (small)

Desktop already has keyboard shortcuts (`Cmd+R` reload, etc.). Add `Cmd+G` to toggle an ABG Monitor panel (docked right or overlay). Cursor controls for replay mode map to ← → Space.

## Tauri Command Stub (Phase 2 reference)

`apps/desktop/src-tauri/src/abg_monitor.rs` (to be created):

```rust
use tauri::{Window, State};

#[tauri::command]
pub async fn subscribe_session_events(
    window: Window,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut next_seq = 0u64;
    loop {
        let events = state
            .desktop_bridge
            .read_session_events_after(&session_id, next_seq)
            .await?;
        for envelope in events {
            next_seq = envelope.sequence + 1;
            window.emit("abg-event", &envelope).map_err(|e| e.to_string())?;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
```

This is illustrative — production needs bounded retries, error recovery, cursor persistence, and a clean cancel path. Documented here as the architectural shape.

## Scope Boundary

- **Not in v2:** full live event stream implementation (Phase 2), shared Ink/DOM component adapter (Phase 1 adapter layer), multi-graph desktop views (depends on Phase 1 graph-switcher).
- **In v2 (this document):** design path, projector-extraction plan, Tauri command shape, scope boundary.

## Next Action

When v3 starts: extract projectors to `packages/core/src/abg-overlay/` first (Phase 1), then prototype the Tauri command bridge against a single test session. Do NOT attempt to share Ink components with the desktop — parallel panes are cheaper and clearer.
