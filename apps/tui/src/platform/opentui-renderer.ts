/**
 * opentui renderer mount/unmount wrapper.
 *
 * Mounts through the opentui runtime: `createCliRenderer` plus
 * `createRoot(renderer).render(element)`.
 *
 * Dynamic imports keep `@opentui/core` and `@opentui/react` out of the eager
 * module graph when the CLI runs in non-TUI mode (plain / JSON output). The
 * native FFI backend is selected automatically by opentui: `bun:ffi` under Bun,
 * or `node:ffi` under Node 26.3+ (requires `--experimental-ffi`).
 *
 * Resize handling: OpenTUI's CliRenderer auto-wires `process.on("SIGWINCH")`
 * when stdout === process.stdout. The handler reads stdout.columns/rows,
 * resizes native buffers, emits a "resize" event, and calls requestRender().
 * React's useTerminalDimensions() subscribes to that event and triggers
 * re-renders.
 *
 * A polling fallback (`attachRendererResizeSync`) supplements SIGWINCH because
 * SIGWINCH alone is unreliable under tmux pane resizes and certain terminal
 * multiplexers where `stdout.columns`/`stdout.rows` may be stale when the
 * signal handler runs. The poll probes the terminal size every 250ms (and on
 * `source.on('resize')`) and calls `renderer.resize()` when dimensions differ.
 * `renderer.resize()` internally early-returns if dimensions already match,
 * so redundant calls are harmless. No raw ANSI screen clears are emitted —
 * those previously bypassed OpenTUI's render pipeline and corrupted the
 * visual state that `processResize` had just set up.
 */

import type { CliRenderer } from '@opentui/core';
import type { Root } from '@opentui/react';
import type { ReactNode } from 'react';
import { execFileSync } from 'node:child_process';

export type TerminalSize = {
    readonly columns: number;
    readonly rows: number;
};

export type TerminalResizeSource = {
    readonly columns?: number;
    readonly rows?: number;
    getWindowSize?: () => readonly [number, number];
    on?: (event: 'resize', listener: () => void) => unknown;
    off?: (event: 'resize', listener: () => void) => unknown;
};

export type RendererResizeTarget = {
    readonly width: number;
    readonly height: number;
    resize(width: number, height: number): void;
    requestRender?: () => void;
};

export type RendererResizeSyncOptions = {
    readonly pollIntervalMs?: number;
    readonly sizeProbe?: TerminalSizeProbe;
};

const DEFAULT_RESIZE_POLL_INTERVAL_MS = 250;

export type TerminalSizeProbe = () => TerminalSize | undefined;

export type TmuxPaneSizeCommand = (paneId: string) => string;

export type TmuxPaneEnvironment = {
    readonly TMUX_PANE?: string;
};

function positiveInteger(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value <= 0) return undefined;
    return value;
}

export function parseTmuxPaneSize(output: string): TerminalSize | undefined {
    const parts = output.trim().split(/\s+/);
    if (parts.length !== 2) return undefined;
    const columns = positiveInteger(Number.parseInt(parts[0] ?? '', 10));
    const rows = positiveInteger(Number.parseInt(parts[1] ?? '', 10));
    if (columns === undefined || rows === undefined) return undefined;
    return { columns, rows };
}

function defaultTmuxPaneSizeCommand(paneId: string): string {
    return execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_width} #{pane_height}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 100,
    });
}

export function readTmuxPaneSize(
    environment: TmuxPaneEnvironment = process.env,
    runTmux: TmuxPaneSizeCommand = defaultTmuxPaneSizeCommand,
): TerminalSize | undefined {
    const paneId = environment.TMUX_PANE;
    if (paneId === undefined || paneId.length === 0) return undefined;
    try {
        return parseTmuxPaneSize(runTmux(paneId));
    } catch (error) {
        if (error instanceof Error) return undefined;
        throw error;
    }
}

export function readTerminalSize(
    source: TerminalResizeSource = process.stdout,
    sizeProbe?: TerminalSizeProbe,
): TerminalSize {
    const probedSize = sizeProbe?.();
    if (probedSize !== undefined) return probedSize;
    const windowSize = source.getWindowSize?.();
    return {
        columns: positiveInteger(windowSize?.[0]) ?? positiveInteger(source.columns) ?? 80,
        rows: positiveInteger(windowSize?.[1]) ?? positiveInteger(source.rows) ?? 24,
    };
}

/**
 * Read the live terminal size and call `renderer.resize()` when it differs
 * from the renderer's current dimensions.
 *
 * This supplements OpenTUI's built-in SIGWINCH handler, which is unreliable
 * under tmux pane resizes and certain terminal multiplexers where
 * `stdout.columns`/`stdout.rows` may be stale when the signal fires. The
 * renderer's internal `processResize` early-returns when dimensions match,
 * so redundant calls (e.g. SIGWINCH already handled it) are harmless no-ops.
 *
 * No raw ANSI screen clears are emitted. The `forceFullRepaintRequested` flag
 * is set so the next render writes every cell, and `requestRender()` is called
 * to schedule it. OpenTUI's `processResize` already handles buffer resizing,
 * root renderable resizing, and the "resize" event emission internally.
 *
 * @returns `true` if the renderer was resized, `false` if dimensions matched.
 */
export function syncRendererToTerminalSize(
    renderer: RendererResizeTarget,
    source: TerminalResizeSource = process.stdout,
    options: RendererResizeSyncOptions = {},
): boolean {
    const size = readTerminalSize(source, options.sizeProbe);
    if (renderer.width === size.columns && renderer.height === size.rows) return false;
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.resize(size.columns, size.rows);
    renderer.requestRender?.();
    return true;
}

/**
 * Attach ongoing terminal resize synchronization to a renderer.
 *
 * Three mechanisms work together:
 * 1. **Immediate sync** — calls `syncRendererToTerminalSize` once on attach so
 *    the renderer matches the real terminal size before the first frame.
 * 2. **`source.on('resize')`** — listens for Node.js `stdout` resize events
 *    (fired by some terminal emulators independently of SIGWINCH).
 * 3. **Polling fallback** — probes every `pollIntervalMs` (default 250ms) to
 *    catch resizes that neither SIGWINCH nor `source.on('resize')` delivered,
 *    which is common under tmux pane resizes.
 *
 * The returned cleanup function removes all listeners and clears the timer.
 * Pass `pollIntervalMs: 0` to disable polling (only `source.on('resize')`
 * remains).
 */
export function attachRendererResizeSync(
    renderer: RendererResizeTarget,
    source: TerminalResizeSource = process.stdout,
    options: RendererResizeSyncOptions = {},
): () => void {
    const sync = (): void => {
        syncRendererToTerminalSize(renderer, source, options);
    };
    sync();
    source.on?.('resize', sync);
    const intervalMs = options.pollIntervalMs ?? DEFAULT_RESIZE_POLL_INTERVAL_MS;
    const timer = intervalMs > 0 ? setInterval(sync, intervalMs) : undefined;
    let attached = true;
    return (): void => {
        if (!attached) return;
        attached = false;
        source.off?.('resize', sync);
        if (timer !== undefined) clearInterval(timer);
    };
}

export type RendererSurfaceResetTarget = {
    requestRender?: () => void;
};

type BufferClearFn = (this: unknown, backgroundColor: unknown) => unknown;

function isBufferClearFn(value: unknown): value is BufferClearFn {
    return typeof value === 'function';
}

function clearRendererBuffer(buffer: unknown, backgroundColor: unknown): void {
    const clear: unknown = Reflect.get(Object(buffer), 'clear');
    if (!isBufferClearFn(clear)) return;
    clear.call(buffer, backgroundColor);
}

/**
 * Force a full repaint of the OpenTUI renderer.
 *
 * OpenTUI's double-buffer diff can miss cells when a wide character (Korean
 * Hangul, emoji) is replaced by a narrow one — the continuation cell is not
 * marked dirty, leaving stale pixels that look like garbled text. This function
 * clears the internal render buffers and sets the forceFullRepaintRequested
 * flag so the next render skips the diff and writes every cell.
 *
 * Uses Reflect to access internal renderer fields because OpenTUI does not
 * expose a public "force full repaint" API. The fields accessed are:
 * - `backgroundColor` (read): used to clear buffers with the correct bg color
 * - `currentRenderBuffer` / `nextRenderBuffer` (read + clear): the swap buffers
 * - `forceFullRepaintRequested` (write): the internal flag that skips diffing
 *
 * Unlike the previous implementation, this does NOT write raw ANSI escape
 * sequences to clear the terminal surface — that bypassed OpenTUI's render
 * pipeline and could corrupt the visual state that processResize just set up.
 */
export function hardResetRendererSurface(renderer: RendererSurfaceResetTarget): void {
    const backgroundColor: unknown = Reflect.get(renderer, 'backgroundColor');
    clearRendererBuffer(Reflect.get(renderer, 'currentRenderBuffer'), backgroundColor);
    clearRendererBuffer(Reflect.get(renderer, 'nextRenderBuffer'), backgroundColor);
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.requestRender?.();
}

/** Result of mounting an opentui renderer: the live handles plus an unmount function. */
export interface OpenTuiMountResult {
    readonly renderer: CliRenderer;
    readonly root: Root;
    unmount(): void;
}

/**
 * Mount a React element into an opentui renderer.
 *
 * Creates the renderer via `createCliRenderer({ exitOnCtrlC: false })`, mounts
 * the React tree via `createRoot(renderer).render(element)`, and returns a
 * handle whose `unmount()` tears down both the React root and the renderer.
 * `unmount()` is idempotent — calling it more than once is a no-op.
 *
 * Resize synchronization is attached via `attachRendererResizeSync`, which
 * supplements OpenTUI's built-in SIGWINCH handler with a 250ms polling
 * fallback and a `stdout.on('resize')` listener. Under tmux, SIGWINCH alone
 * is unreliable because `stdout.columns`/`stdout.rows` may be stale when the
 * signal handler runs.
 */
export async function mountOpenTui(element: ReactNode): Promise<OpenTuiMountResult> {
    const { createCliRenderer } = await import('@opentui/core');
    const { createRoot } = await import('@opentui/react');

    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    const detachResizeSync = attachRendererResizeSync(renderer, process.stdout, { sizeProbe: readTmuxPaneSize });

    const root = createRoot(renderer);
    root.render(element);

    let unmounted = false;
    return {
        renderer,
        root,
        unmount(): void {
            if (unmounted) return;
            unmounted = true;
            detachResizeSync();
            root.unmount();
            renderer.destroy();
        },
    };
}
