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
 */
export async function mountOpenTui(element: ReactNode): Promise<OpenTuiMountResult> {
    const { createCliRenderer } = await import('@opentui/core');
    const { createRoot } = await import('@opentui/react');

    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    const root = createRoot(renderer);
    root.render(element);

    let unmounted = false;
    return {
        renderer,
        root,
        unmount(): void {
            if (unmounted) return;
            unmounted = true;
            root.unmount();
            renderer.destroy();
        },
    };
}
