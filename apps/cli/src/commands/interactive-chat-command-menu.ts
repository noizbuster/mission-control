import { terminalDisplayWidth, truncateTerminalText } from './terminal-text.js';

export type SlashCommandMenuChoice = {
    readonly id: string;
    readonly insertText: string;
    readonly description: string;
};

export type SlashCommandMenuState = {
    readonly selectedIndex: number;
};

export type SlashCommandMenuView = {
    readonly open: boolean;
    readonly query: string;
    readonly selectedIndex: number;
    readonly startIndex: number;
    readonly totalCount: number;
    readonly visibleChoices: readonly SlashCommandMenuChoice[];
    readonly empty: boolean;
};

const arrowUpSequence = '\u001b[A';
const arrowDownSequence = '\u001b[B';
const resetStyle = '\u001b[0m';
const selectedStyle = '\u001b[48;5;60m\u001b[38;5;231m';

const slashCommandChoices = [
    {
        id: '/model',
        insertText: '/model',
        description: 'Open the model and variant picker',
    },
    {
        id: '/model pick',
        insertText: '/model pick',
        description: 'Open the model picker',
    },
    {
        id: '/model list',
        insertText: '/model list',
        description: 'List available models',
    },
    {
        id: '/queue',
        insertText: '/queue ',
        description: 'Queue a follow-up prompt',
    },
    {
        id: '/steer',
        insertText: '/steer ',
        description: 'Steer the active run',
    },
    {
        id: '/resume',
        insertText: '/resume',
        description: 'Resume pending work',
    },
    {
        id: '/interrupt',
        insertText: '/interrupt',
        description: 'Interrupt the active run',
    },
    {
        id: '/exit',
        insertText: '/exit',
        description: 'Stop active runs and exit',
    },
    {
        id: '/branch',
        insertText: '/branch ',
        description: 'Continue from a message id',
    },
] as const satisfies readonly SlashCommandMenuChoice[];

export function createSlashCommandMenuState(): SlashCommandMenuState {
    return { selectedIndex: 0 };
}

export function createSlashCommandMenuView(
    line: string,
    state: SlashCommandMenuState,
    maxVisibleChoices: number,
): SlashCommandMenuView {
    const query = readSlashCommandQuery(line);
    if (query === undefined) {
        return closedMenuView;
    }
    const filteredChoices = filterSlashCommandChoices(query);
    const selectedIndex = clampSelection(state.selectedIndex, filteredChoices.length);
    const visibleLimit = Math.max(1, maxVisibleChoices);
    const startIndex = getWindowStartIndex(selectedIndex, filteredChoices.length, visibleLimit);
    return {
        open: true,
        query,
        selectedIndex,
        startIndex,
        totalCount: filteredChoices.length,
        visibleChoices: filteredChoices.slice(startIndex, startIndex + visibleLimit),
        empty: filteredChoices.length === 0,
    };
}

export function reduceSlashCommandMenuSelection(
    state: SlashCommandMenuState,
    chunk: string,
    line: string,
): SlashCommandMenuState {
    const view = createSlashCommandMenuView(line, state, slashCommandChoices.length);
    if (!view.open || view.totalCount === 0) {
        return { selectedIndex: 0 };
    }
    if (chunk.includes(arrowDownSequence)) {
        return { selectedIndex: Math.min(view.selectedIndex + 1, view.totalCount - 1) };
    }
    if (chunk.includes(arrowUpSequence)) {
        return { selectedIndex: Math.max(view.selectedIndex - 1, 0) };
    }
    return { selectedIndex: view.selectedIndex };
}

export function resolveSlashCommandMenuSubmission(line: string, state: SlashCommandMenuState): string {
    const view = createSlashCommandMenuView(line, state, slashCommandChoices.length);
    const selectedChoice = view.visibleChoices[view.selectedIndex - view.startIndex];
    if (!view.open || selectedChoice === undefined) {
        return line;
    }
    return selectedChoice.insertText.trimEnd();
}

export function formatSlashCommandMenuLines(view: SlashCommandMenuView, columns: number): readonly string[] {
    const header = truncateTerminalText(`Commands${view.query.length > 0 ? ` matching "${view.query}"` : ''}`, columns);
    if (view.empty) {
        return [header, truncateTerminalText('  no commands match', columns)];
    }
    const choiceLines = view.visibleChoices.map((choice, index) => {
        const globalIndex = view.startIndex + index;
        const marker = globalIndex === view.selectedIndex ? '>' : ' ';
        const plainLine = `${marker} ${padEndByDisplayWidth(choice.id, 13)} ${choice.description}`;
        const truncated = truncateTerminalText(plainLine, columns);
        return globalIndex === view.selectedIndex ? `${selectedStyle}${truncated}${resetStyle}` : truncated;
    });
    return [header, ...choiceLines];
}

const closedMenuView = {
    open: false,
    query: '',
    selectedIndex: 0,
    startIndex: 0,
    totalCount: 0,
    visibleChoices: [],
    empty: false,
} satisfies SlashCommandMenuView;

function readSlashCommandQuery(line: string): string | undefined {
    if (!line.startsWith('/')) {
        return undefined;
    }
    const commandToken = line.slice(1);
    if (commandToken.includes(' ') || commandToken.includes('\n') || commandToken.includes('\t')) {
        return undefined;
    }
    return commandToken.toLowerCase();
}

function filterSlashCommandChoices(query: string): readonly SlashCommandMenuChoice[] {
    if (query.length === 0) {
        return slashCommandChoices;
    }
    return slashCommandChoices.filter(
        (choice) =>
            choice.id.slice(1).toLowerCase().includes(query) || choice.description.toLowerCase().includes(query),
    );
}

function clampSelection(selectedIndex: number, totalCount: number): number {
    if (totalCount <= 0) {
        return 0;
    }
    return Math.min(Math.max(selectedIndex, 0), totalCount - 1);
}

function getWindowStartIndex(selectedIndex: number, totalCount: number, visibleLimit: number): number {
    if (totalCount <= visibleLimit) {
        return 0;
    }
    const halfWindow = Math.floor(visibleLimit / 2);
    return Math.min(Math.max(selectedIndex - halfWindow, 0), totalCount - visibleLimit);
}

function padEndByDisplayWidth(value: string, width: number): string {
    return `${value}${' '.repeat(Math.max(0, width - terminalDisplayWidth(value)))}`;
}
