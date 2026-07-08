/**
 * @mission-control/tui — private internal workspace app.
 *
 * The `.` entry re-exports the pure no-OpenTUI primitives AND the state cluster.
 * The OpenTUI mount surface (renderer + keymap provider) lives behind dedicated
 * subpath exports (`./opentui-renderer`, `./keymap-provider`) so it is NOT
 * pulled into the main barrel — the barrel stays free of `@opentui/*` at
 * runtime, and the CLI reaches the mount surface exclusively via dynamic import
 * so non-interactive runs never load the native renderer.
 *
 * The `@mission-control/tui/state` subpath re-exports ONLY the pure state
 * cluster — CLI runtime imports eagerly from it so `mc --no-tui` stays opentui-free.
 */

export const TUI_PACKAGE_NAME = '@mission-control/tui';

export * from './chat.js';
export * from './markdown.js';
export * from './state/index.js';
export * from './terminal-text.js';
