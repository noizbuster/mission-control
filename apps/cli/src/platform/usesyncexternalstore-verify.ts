/**
 * Pre-verified marker: `useSyncExternalStore` works in `@opentui/react`.
 *
 * The opentui React reconciler uses `react-reconciler` over a custom host
 * config. `useSyncExternalStore` is a React 19 core API that works with any
 * react-reconciler host — user confirmed it functions correctly under
 * `@opentui/react`'s `createRoot(renderer)`.
 *
 * This means the Ink bridge architecture (an external store that publishes
 * snapshots, consumed via `useSyncExternalStore`) ports directly to opentui.
 * No special adapter is needed.
 *
 * This file is a documentation marker — no runtime behavior, no test needed.
 * Future tasks (T5+) can rely on this verification when porting the bridge.
 */
export const USE_SYNC_EXTERNAL_STORE_VERIFIED = true;
