import { useTerminalDimensions } from '@opentui/react';
import { useMemo } from 'react';
import { createTerminalViewportCache, type TerminalViewport } from './terminal-viewport.js';

export function useTerminalViewport(): TerminalViewport {
    const dimensions = useTerminalDimensions();
    const normalize = useMemo(() => createTerminalViewportCache(), []);
    return normalize(dimensions);
}
