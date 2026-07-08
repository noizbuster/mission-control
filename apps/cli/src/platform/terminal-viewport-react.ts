import { useRenderer } from '@opentui/react';
import {
    createTerminalViewportCache,
    type TerminalViewport,
    type OpenTuiTerminalDimensions,
} from './terminal-viewport.js';
import { useCallback, useSyncExternalStore } from 'react';

export function useTerminalViewport(): TerminalViewport {
    const renderer = useRenderer();
    const cache = useCallback(() => createTerminalViewportCache(), [])();
    const subscribe = useCallback(
        (cb: () => void) => {
            renderer.on('resize', cb);
            return () => {
                renderer.off('resize', cb);
            };
        },
        [renderer],
    );
    const getSnapshot = useCallback((): TerminalViewport => {
        const dims: OpenTuiTerminalDimensions = { width: renderer.width, height: renderer.height };
        return cache(dims);
    }, [renderer, cache]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
