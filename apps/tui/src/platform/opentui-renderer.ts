/**
 * OpenTUI mount — OpenCode createCliRenderer + render
 * (ref/opencode/packages/tui/src/app.tsx).
 *
 * processResize emits "resize" then requestRender. Solid useTerminalDimensions
 * registers onMount during render. Full-paint attaches after render so it runs
 * after Solid resize handlers; queueMicrotask lets prop/layout effects flush
 * before forceFullRepaint (Node expand blanks otherwise).
 */

import type { CliRenderer } from '@opentui/core';
import type { JSX } from '@opentui/solid';

export interface OpenTuiMountResult {
    readonly renderer: CliRenderer;
    unmount(): void;
}

export function attachResizeFullPaint(renderer: CliRenderer): () => void {
    const onResize = (): void => {
        queueMicrotask(() => {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        });
    };
    renderer.on('resize', onResize);
    return (): void => {
        renderer.off('resize', onResize);
    };
}

export async function mountOpenTui(app: () => JSX.Element): Promise<OpenTuiMountResult> {
    const { createCliRenderer } = await import('@opentui/core');
    const { render } = await import('@opentui/solid');

    const renderer = await createCliRenderer({
        externalOutputMode: 'passthrough',
        targetFps: 60,
        exitOnCtrlC: false,
        // The transcript scrollbar uses pointer capture while dragging; keep
        // both click and drag tracking enabled instead of relying on defaults.
        useMouse: true,
        enableMouseMovement: true,
        useKittyKeyboard: {},
        autoFocus: false,
        openConsoleOnError: false,
    });
    await render(app, renderer);
    const detachResizeFullPaint = attachResizeFullPaint(renderer);

    let unmounted = false;
    return {
        renderer,
        unmount(): void {
            if (unmounted) return;
            unmounted = true;
            detachResizeFullPaint();
            renderer.destroy();
        },
    };
}
