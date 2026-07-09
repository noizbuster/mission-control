import { useTerminalDimensions } from '@opentui/solid';
import { type Accessor, createMemo } from 'solid-js';
import {
    createTerminalViewportCache,
    type OpenTuiTerminalDimensions,
    type TerminalViewport,
} from './terminal-viewport.js';

export function useTerminalViewport(): Accessor<TerminalViewport> {
    // Delegate reactive terminal sizing to the official OpenTUI Solid hook. It
    // owns the renderer subscription (seed + resize) and returns a Solid signal
    // of `{ width, height }`. We compose it with the pure normalization cache so
    // callers keep receiving the `TerminalViewport { columns, rows }` shape with
    // referentially stable updates and safe fallbacks.
    const dimensions = useTerminalDimensions();
    const cache = createTerminalViewportCache();
    return createMemo<TerminalViewport>(() =>
        cache({ width: dimensions().width, height: dimensions().height } satisfies OpenTuiTerminalDimensions),
    );
}
