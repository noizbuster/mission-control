/**
 * opentui renderer mount/unmount — OpenCode-aligned.
 *
 * Resize is owned solely by OpenTUI CliRenderer (built-in terminal resize →
 * processResize → "resize" event → useTerminalDimensions). No poll, no stdout
 * listener, no force-repaint ladder — same as OpenCode.
 */

import type { CliRenderer } from '@opentui/core';
import type { JSX } from '@opentui/solid';

export interface OpenTuiMountResult {
    readonly renderer: CliRenderer;
    unmount(): void;
}

export async function mountOpenTui(app: () => JSX.Element): Promise<OpenTuiMountResult> {
    const { createCliRenderer } = await import('@opentui/core');
    const { render } = await import('@opentui/solid');

    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 60,
        externalOutputMode: 'passthrough',
        autoFocus: false,
        openConsoleOnError: false,
        useKittyKeyboard: {},
    });
    await render(app, renderer);

    let unmounted = false;
    return {
        renderer,
        unmount(): void {
            if (unmounted) return;
            unmounted = true;
            renderer.destroy();
        },
    };
}
