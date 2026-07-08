import { ClipboardTarget } from '@opentui/core';

/**
 * Minimal renderer surface the OSC52 clipboard service depends on.
 *
 * Structurally compatible with opentui's `CliRenderer`, which exposes
 * `copyToClipboardOSC52(text, target?): boolean` and `isOsc52Supported(): boolean`.
 * Kept as a structural interface (not the concrete `CliRenderer` import) so unit
 * tests can inject a plain mock without standing up the native renderer.
 */
export interface ClipboardServiceRenderer {
    copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean;
    isOsc52Supported(): boolean;
}

/** OSC52-only clipboard service. Resolves `false` on terminals without OSC52. */
export interface ClipboardService {
    copyToClipboard(text: string): Promise<boolean>;
    isOsc52Supported(): boolean;
}

/**
 * Build an OSC52-only clipboard service bound to a renderer handle.
 *
 * The caller passes the live renderer (e.g. `OpenTuiMountResult.renderer`);
 * this module never resolves the renderer at import time. The escape sequence
 * is owned by opentui's native core — this layer emits nothing to stdout
 * directly and never shells out to `pbcopy`/`xclip`/`wl-copy`/`osascript`.
 */
export function createClipboardService(renderer: ClipboardServiceRenderer): ClipboardService {
    function copyToClipboard(text: string): Promise<boolean> {
        if (!renderer.isOsc52Supported()) return Promise.resolve(false);
        return Promise.resolve(renderer.copyToClipboardOSC52(text, ClipboardTarget.Clipboard));
    }

    function isOsc52Supported(): boolean {
        return renderer.isOsc52Supported();
    }

    return { copyToClipboard, isOsc52Supported };
}
