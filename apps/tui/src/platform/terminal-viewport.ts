export type OpenTuiTerminalDimensions = {
    readonly width?: number;
    readonly height?: number;
};

export type TerminalViewport = {
    readonly columns: number;
    readonly rows: number;
};

export const DEFAULT_TERMINAL_VIEWPORT = {
    columns: 80,
    rows: 24,
} as const satisfies TerminalViewport;

function terminalCell(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Pure width/height → columns/rows normalize (no cache). */
export function normalizeTerminalViewport(dimensions: OpenTuiTerminalDimensions): TerminalViewport {
    return {
        columns: terminalCell(dimensions.width, DEFAULT_TERMINAL_VIEWPORT.columns),
        rows: terminalCell(dimensions.height, DEFAULT_TERMINAL_VIEWPORT.rows),
    };
}
