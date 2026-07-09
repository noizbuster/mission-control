import { useTerminalDimensions } from '@opentui/solid';
import { type Accessor, createMemo } from 'solid-js';
import type { TerminalViewport } from './terminal-viewport.js';

/**
 * Thin OpenCode-compatible adapter: useTerminalDimensions() → { columns, rows }.
 *
 * No cache and no extra signals. OpenCode reads dimensions().width in JSX;
 * we only rename width/height → columns/rows for existing MC call sites.
 * The previous createTerminalViewportCache was redundant with createMemo and
 * added an extra object layer that is not part of the OpenTUI model.
 */
export function useTerminalViewport(): Accessor<TerminalViewport> {
    const dimensions = useTerminalDimensions();
    return createMemo(() => ({
        columns: dimensions().width,
        rows: dimensions().height,
    }));
}
