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

type RendererResizeListener = (width: number, height: number) => void;

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
    on?: (event: 'resize', listener: RendererResizeListener) => unknown;
    off?: (event: 'resize', listener: RendererResizeListener) => unknown;
};

export type RendererResizeSyncOptions = {
    readonly pollIntervalMs?: number;
    readonly sizeProbe?: TerminalSizeProbe;
};

const DEFAULT_RESIZE_POLL_INTERVAL_MS = 250;
const CLEAR_TERMINAL_SURFACE = '\x1B[r\x1B[0m\x1B[H\x1B[2J\x1B[3J\x1B[H';

type RendererWriteOut = (this: RendererResizeTarget, chunk: string) => unknown;
type RendererBufferClear = (this: unknown, backgroundColor: unknown) => unknown;

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

function isRendererWriteOut(value: unknown): value is RendererWriteOut {
    return typeof value === 'function';
}

function isRendererBufferClear(value: unknown): value is RendererBufferClear {
    return typeof value === 'function';
}

function isTerminalShrinking(renderer: RendererResizeTarget, size: TerminalSize): boolean {
    return size.columns < renderer.width || size.rows < renderer.height;
}

function clearTerminalSurface(renderer: RendererResizeTarget): void {
    const writeOut: unknown = Reflect.get(renderer, 'writeOut');
    if (!isRendererWriteOut(writeOut)) return;
    writeOut.call(renderer, CLEAR_TERMINAL_SURFACE);
}

function clearRendererBuffer(buffer: unknown, backgroundColor: unknown): void {
    const clear: unknown = Reflect.get(Object(buffer), 'clear');
    if (!isRendererBufferClear(clear)) return;
    clear.call(buffer, backgroundColor);
}

function clearRendererBuffers(renderer: RendererResizeTarget): void {
    const backgroundColor: unknown = Reflect.get(renderer, 'backgroundColor');
    clearRendererBuffer(Reflect.get(renderer, 'currentRenderBuffer'), backgroundColor);
    clearRendererBuffer(Reflect.get(renderer, 'nextRenderBuffer'), backgroundColor);
}

export function hardResetRendererSurface(renderer: RendererResizeTarget): void {
    clearTerminalSurface(renderer);
    clearRendererBuffers(renderer);
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.requestRender?.();
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
    const size = readTerminalSize(source, options.sizeProbe);
    if (renderer.width === size.columns && renderer.height === size.rows) return false;
    if (isTerminalShrinking(renderer, size)) clearTerminalSurface(renderer);
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.resize(size.columns, size.rows);
    renderer.requestRender?.();
    return true;
}

export function attachRendererResizeSync(
    renderer: RendererResizeTarget,
    source: TerminalResizeSource = process.stdout,
    options: RendererResizeSyncOptions = {},
): () => void {
    let lastRendererSize: TerminalSize = { columns: renderer.width, rows: renderer.height };
    const handleRendererResize = (width: number, height: number): void => {
        const nextSize = {
            columns: positiveInteger(width) ?? renderer.width,
            rows: positiveInteger(height) ?? renderer.height,
        };
        const shrinking = nextSize.columns < lastRendererSize.columns || nextSize.rows < lastRendererSize.rows;
        lastRendererSize = nextSize;
        if (!shrinking) return;
        hardResetRendererSurface(renderer);
    };
    const sync = (): void => {
        syncRendererToTerminalSize(renderer, source, options);
    };
    renderer.on?.('resize', handleRendererResize);
    sync();
    source.on?.('resize', sync);
    const intervalMs = options.pollIntervalMs ?? DEFAULT_RESIZE_POLL_INTERVAL_MS;
    const timer = intervalMs > 0 ? setInterval(sync, intervalMs) : undefined;
    let attached = true;
    return (): void => {
        if (!attached) return;
        attached = false;
        source.off?.('resize', sync);
        renderer.off?.('resize', handleRendererResize);
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
