export type OpenTuiTerminalDimensions = {
    readonly width?: number;
    readonly height?: number;
};

export type TerminalViewport = {
    readonly columns: number;
    readonly rows: number;
};

export type TerminalViewportNormalizer = (dimensions: OpenTuiTerminalDimensions) => TerminalViewport;

export const DEFAULT_TERMINAL_VIEWPORT = {
    columns: 80,
    rows: 24,
} as const satisfies TerminalViewport;

function terminalCell(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function sameTerminalViewport(left: TerminalViewport, right: TerminalViewport): boolean {
    return left.columns === right.columns && left.rows === right.rows;
}

export function normalizeTerminalViewport(dimensions: OpenTuiTerminalDimensions): TerminalViewport {
    return {
        columns: terminalCell(dimensions.width, DEFAULT_TERMINAL_VIEWPORT.columns),
        rows: terminalCell(dimensions.height, DEFAULT_TERMINAL_VIEWPORT.rows),
    };
}

export function createTerminalViewportCache(): TerminalViewportNormalizer {
    let cachedViewport: TerminalViewport | undefined;
    return (dimensions): TerminalViewport => {
        const nextViewport = normalizeTerminalViewport(dimensions);
        if (cachedViewport !== undefined && sameTerminalViewport(cachedViewport, nextViewport)) return cachedViewport;
        cachedViewport = nextViewport;
        return nextViewport;
    };
}
