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
import {
    emergencyTerminalRestore,
    registerEmergencyTerminalRestoreGlobal,
    setAltScreenActive,
    setTerminalSessionActive,
    unregisterEmergencyTerminalRestoreGlobal,
} from './emergency-terminal-restore';
import { LoopWatchdog } from './loop-watchdog';

export interface OpenTuiMountResult {
    readonly renderer: CliRenderer;
    unmount(): void;
}

export function attachResizeFullPaint(renderer: CliRenderer): () => void {
    let disposed = false;
    let pending = false;
    const onResize = (): void => {
        if (disposed || pending) return;
        pending = true;
        queueMicrotask(() => {
            pending = false;
            if (disposed) return;
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        });
    };
    renderer.on('resize', onResize);
    return (): void => {
        disposed = true;
        renderer.off('resize', onResize);
    };
}

export async function mountOpenTui(app: () => JSX.Element): Promise<OpenTuiMountResult> {
    // Dynamic import keeps non-TUI CLI graphs free of the native OpenTUI FFI.
    const { createCliRenderer } = await import('@opentui/core');
    const { render } = await import('@opentui/solid');

    const renderer = await createCliRenderer({
        screenMode: 'alternate-screen',
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
    // The renderer owns the alternate screen for the entire mount, not merely
    // while an application overlay is fullscreen. Register recovery before
    // Solid mounts so a render failure cannot strand raw mode or the alt buffer.
    setTerminalSessionActive(true);
    setAltScreenActive(true);
    registerEmergencyTerminalRestoreGlobal();

    try {
        await render(app, renderer);
        const detachResizeFullPaint = attachResizeFullPaint(renderer);
        const watchdog = new LoopWatchdog();
        watchdog.start();

        let unmounted = false;
        return {
            renderer,
            unmount(): void {
                if (unmounted) return;
                unmounted = true;
                watchdog.stop();
                detachResizeFullPaint();
                try {
                    renderer.destroy();
                } finally {
                    // Always restore terminal modes even if destroy throws mid-teardown.
                    emergencyTerminalRestore();
                    unregisterEmergencyTerminalRestoreGlobal();
                }
            },
        };
    } catch (error: unknown) {
        try {
            renderer.destroy();
        } finally {
            emergencyTerminalRestore();
            unregisterEmergencyTerminalRestoreGlobal();
        }
        throw error;
    }
}
