import { useRenderer } from '@opentui/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import {
    createTerminalViewportCache,
    type OpenTuiTerminalDimensions,
    type TerminalViewport,
} from './terminal-viewport.js';

export function useTerminalViewport(): TerminalViewport {
    const renderer = useRenderer();
    const cache = createTerminalViewportCache();
    const readViewport = (): TerminalViewport => {
        const dims: OpenTuiTerminalDimensions = { width: renderer.width, height: renderer.height };
        return cache(dims);
    };
    const [viewport, setViewport] = createSignal(readViewport(), { equals: Object.is });

    onMount(() => {
        const handleResize = (): void => {
            setViewport(() => cache({ width: renderer.width, height: renderer.height }));
        };

        renderer.on('resize', handleResize);
        onCleanup(() => {
            renderer.off('resize', handleResize);
        });
    });

    return viewport();
}
