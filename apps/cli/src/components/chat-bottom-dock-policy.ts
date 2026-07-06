export const BOTTOM_DOCK_WIDTH_BREAKPOINTS = {
    commandHint: 66,
    normal: 80,
    wide: 120,
    spacious: 150,
} as const;

export const BOTTOM_DOCK_HEIGHT_POLICY = {
    minTranscriptRows: 4,
    statusRows: 2,
    inputRows: 1,
    maxMenuRows: {
        narrow: 3,
        compact: 4,
        normal: 5,
        wide: 8,
        spacious: 10,
    },
} as const;

export type BottomDockWidthClass = keyof typeof BOTTOM_DOCK_HEIGHT_POLICY.maxMenuRows;

export type BottomDockPolicyInput = {
    readonly columns: number;
    readonly rows: number;
};

export type BottomDockStatusPolicy = {
    readonly rows: typeof BOTTOM_DOCK_HEIGHT_POLICY.statusRows;
    readonly showCommandHint: boolean;
    readonly showContextUsage: boolean;
    readonly showProject: boolean;
    readonly showSession: boolean;
};

export type BottomDockMenuPolicy = {
    readonly rows: number;
    readonly showPanelFooter: boolean;
};

export type BottomDockInputPolicy = {
    readonly rows: typeof BOTTOM_DOCK_HEIGHT_POLICY.inputRows;
};

export type BottomDockTranscriptPolicy = {
    readonly rows: number;
};

export type BottomDockPolicy = {
    readonly columns: number;
    readonly rows: number;
    readonly widthClass: BottomDockWidthClass;
    readonly status: BottomDockStatusPolicy;
    readonly menu: BottomDockMenuPolicy;
    readonly input: BottomDockInputPolicy;
    readonly transcript: BottomDockTranscriptPolicy;
};

export function bottomDockPolicy(input: BottomDockPolicyInput): BottomDockPolicy {
    const columns = clampDimension(input.columns);
    const rows = Math.max(clampDimension(input.rows), minimumReservedRows());
    const widthClass = bottomDockWidthClass(columns);
    const availableMenuRows = Math.max(0, rows - minimumReservedRows());
    const menuRows = Math.min(availableMenuRows, BOTTOM_DOCK_HEIGHT_POLICY.maxMenuRows[widthClass]);

    return {
        columns,
        rows,
        widthClass,
        status: {
            rows: BOTTOM_DOCK_HEIGHT_POLICY.statusRows,
            showCommandHint: columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.commandHint,
            showContextUsage: columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.normal,
            showProject: columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.normal,
            showSession: columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.wide,
        },
        menu: {
            rows: menuRows,
            showPanelFooter: columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.commandHint && menuRows > 0,
        },
        input: {
            rows: BOTTOM_DOCK_HEIGHT_POLICY.inputRows,
        },
        transcript: {
            rows: Math.max(
                BOTTOM_DOCK_HEIGHT_POLICY.minTranscriptRows,
                rows - BOTTOM_DOCK_HEIGHT_POLICY.statusRows - BOTTOM_DOCK_HEIGHT_POLICY.inputRows - menuRows,
            ),
        },
    };
}

function bottomDockWidthClass(columns: number): BottomDockWidthClass {
    if (columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.spacious) return 'spacious';
    if (columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.wide) return 'wide';
    if (columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.normal) return 'normal';
    if (columns >= BOTTOM_DOCK_WIDTH_BREAKPOINTS.commandHint) return 'compact';
    return 'narrow';
}

function clampDimension(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
}

function minimumReservedRows(): number {
    return (
        BOTTOM_DOCK_HEIGHT_POLICY.minTranscriptRows +
        BOTTOM_DOCK_HEIGHT_POLICY.statusRows +
        BOTTOM_DOCK_HEIGHT_POLICY.inputRows
    );
}
