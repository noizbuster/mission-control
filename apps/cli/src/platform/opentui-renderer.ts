/**
 * opentui renderer mount/unmount wrapper.
 *
 * Replaces Ink's `render(<App />, { exitOnCtrlC: false })` with the opentui
 * equivalent: `createCliRenderer` + `createRoot(renderer).render(element)`.
 *
 * Dynamic imports keep `@opentui/core` and `@opentui/react` out of the eager
 * module graph when the CLI runs in non-TUI mode (plain / JSON output). The
 * native FFI backend is selected automatically by opentui: `bun:ffi` under Bun,
 * or `node:ffi` under Node 26.3+ (requires `--experimental-ffi`).
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

export type TerminalSizeProbe = () => TerminalSize | undefined;

export type TmuxPaneSizeCommand = (paneId: string) => string;

export type TmuxPaneEnvironment = {
    readonly TMUX_PANE?: string;
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

/** Result of mounting an opentui renderer: the live handles plus an unmount function. */
export interface OpenTuiMountResult {
    readonly renderer: CliRenderer;
    readonly root: Root;
    unmount(): void;
}

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

export function syncRendererToTerminalSize(
    renderer: RendererResizeTarget,
    source: TerminalResizeSource = process.stdout,
    options: RendererResizeSyncOptions = {},
): boolean {
    const { columns, rows } = readTerminalSize(source, options.sizeProbe);
    if (renderer.width === columns && renderer.height === rows) return false;
    renderer.resize(columns, rows);
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.requestRender?.();
    return true;
}

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
    return (): void => {
        source.off?.('resize', sync);
        if (timer !== undefined) clearInterval(timer);
    };
}

/**
 * Mount a React element into an opentui renderer.
 *
 * Creates the renderer via `createCliRenderer({ exitOnCtrlC: false })`, mounts
 * the React tree via `createRoot(renderer).render(element)`, and returns a
 * handle whose `unmount()` tears down both the React root and the renderer.
 * `unmount()` is idempotent — calling it more than once is a no-op.
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
