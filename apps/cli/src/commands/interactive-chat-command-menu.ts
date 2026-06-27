import { readTerminalCursorDirection } from './interactive-chat-terminal-keys.js';
import { terminalDisplayWidth, truncateTerminalText } from './terminal-text.js';

export type SlashCommandMenuChoice = {
    readonly id: string;
    readonly insertText: string;
    readonly description: string;
    readonly opensPicker?: boolean;
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

const resetStyle = '\u001b[0m';
const selectedStyle = '\u001b[48;5;60m\u001b[38;5;231m';

export const slashCommandChoices = [
    {
        id: '/model',
        insertText: '/model',
        description: 'Open the model and variant picker',
        opensPicker: true,
    },
    {
        id: '/model pick',
        insertText: '/model pick',
        description: 'Open the model picker',
        opensPicker: true,
    },
    {
        id: '/model list',
        insertText: '/model list',
        description: 'List available models',
    },
    {
        id: '/new',
        insertText: '/new ',
        description: 'Start a new durable session',
    },
    {
        id: '/clear',
        insertText: '/clear ',
        description: 'Clear the screen and start a new session',
    },
    {
        id: '/session',
        insertText: '/session ',
        description: 'Open the session picker for this project (or switch by id)',
    },
    {
        id: '/sessions',
        insertText: '/sessions',
        description: 'List durable sessions',
    },
    {
        id: '/tree',
        insertText: '/tree',
        description: 'Show the current session tree',
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
        description: 'Resume the most recent session for this project',
    },
    {
        id: '/continue',
        insertText: '/continue',
        description: 'Resume a blocked approval run',
    },
    {
        id: '/compact',
        insertText: '/compact ',
        description: 'Summarize older session history (optional focus text)',
    },
    {
        id: '/export',
        insertText: '/export ',
        description: 'Export the current session to a file (default: session-<id>.html)',
    },
    {
        id: '/rename',
        insertText: '/rename ',
        description: 'Set the display name for the current session',
    },
    {
        id: '/undo',
        insertText: '/undo',
        description: 'Revert the last user+assistant exchange (display only)',
    },
    {
        id: '/redo',
        insertText: '/redo',
        description: 'Re-apply the last reverted exchange (display only)',
    },
    {
        id: '/trust',
        insertText: '/trust',
        description: 'Trust this workspace',
    },
    {
        id: '/trust status',
        insertText: '/trust status',
        description: 'Show workspace trust',
    },
    {
        id: '/trust deny',
        insertText: '/trust deny',
        description: 'Deny workspace trust',
    },
    {
        id: '/trust reset',
        insertText: '/trust reset',
        description: 'Reset workspace trust',
    },
    {
        id: '/approval',
        insertText: '/approval ',
        description: 'Show or set approval level (verbose/safe/aggressive/reckless/yolo)',
        opensPicker: true,
    },
    {
        id: '/approval verbose',
        insertText: '/approval verbose',
        description: 'Ask for every tool call',
    },
    {
        id: '/approval safe',
        insertText: '/approval safe',
        description: 'Auto-approve reads, ask before modifications',
    },
    {
        id: '/approval aggressive',
        insertText: '/approval aggressive',
        description: 'Auto-approve reads + file edits',
    },
    {
        id: '/approval reckless',
        insertText: '/approval reckless',
        description: 'Auto-approve everything except network',
    },
    {
        id: '/approval yolo',
        insertText: '/approval yolo',
        description: 'Auto-approve everything',
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
        description: 'Select a branch entry or continue from a parent message id',
    },
    {
        id: '/fork',
        insertText: '/fork ',
        description: 'Fork a durable session from a tree entry',
    },
    {
        id: '/clone',
        insertText: '/clone ',
        description: 'Clone the current durable session',
    },
    {
        id: '/help',
        insertText: '/help',
        description: 'Show available commands and keyboard shortcuts',
    },
    {
        id: '/hotkeys',
        insertText: '/hotkeys',
        description: 'Show all keyboard shortcuts',
    },
] as const satisfies readonly SlashCommandMenuChoice[];

export function createSlashCommandMenuState(): SlashCommandMenuState {
    return { selectedIndex: 0 };
}

export function isSlashCommandMenuOpen(line: string): boolean {
    return readCommandQuery(line, '/') !== undefined;
}

export function isWorkflowCommandMenuOpen(line: string): boolean {
    return readCommandQuery(line, '#') !== undefined;
}

export function workflowCommandChoices(workflows: readonly string[]): readonly SlashCommandMenuChoice[] {
    return workflows.map((name) => ({
        id: `#${name}`,
        insertText: `#${name} `,
        description: `Run the ${name} workflow`,
    }));
}

function createCommandMenuView(
    line: string,
    state: SlashCommandMenuState,
    maxVisibleChoices: number,
    prefix: string,
    choices: readonly SlashCommandMenuChoice[],
): SlashCommandMenuView {
    const query = readCommandQuery(line, prefix);
    if (query === undefined) {
        return closedMenuView;
    }
    const filteredChoices = filterCommandChoices(query, choices);
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

export function createSlashCommandMenuView(
    line: string,
    state: SlashCommandMenuState,
    maxVisibleChoices: number,
): SlashCommandMenuView {
    return createCommandMenuView(line, state, maxVisibleChoices, '/', slashCommandChoices);
}

export function createWorkflowCommandMenuView(
    line: string,
    state: SlashCommandMenuState,
    maxVisibleChoices: number,
    workflows: readonly string[],
): SlashCommandMenuView {
    return createCommandMenuView(line, state, maxVisibleChoices, '#', workflowCommandChoices(workflows));
}

function reduceCommandMenuSelection(chunk: string, view: SlashCommandMenuView): SlashCommandMenuState {
    if (!view.open || view.totalCount === 0) {
        return { selectedIndex: 0 };
    }
    const cursorDirection = readTerminalCursorDirection(chunk);
    if (cursorDirection === 'down') {
        return { selectedIndex: Math.min(view.selectedIndex + 1, view.totalCount - 1) };
    }
    if (cursorDirection === 'up') {
        return { selectedIndex: Math.max(view.selectedIndex - 1, 0) };
    }
    return { selectedIndex: view.selectedIndex };
}

export function reduceSlashCommandMenuSelection(
    state: SlashCommandMenuState,
    chunk: string,
    line: string,
): SlashCommandMenuState {
    return reduceCommandMenuSelection(chunk, createSlashCommandMenuView(line, state, slashCommandChoices.length));
}

export function reduceWorkflowCommandMenuSelection(
    state: SlashCommandMenuState,
    chunk: string,
    line: string,
    workflows: readonly string[],
): SlashCommandMenuState {
    return reduceCommandMenuSelection(
        chunk,
        createWorkflowCommandMenuView(line, state, workflowCommandChoices(workflows).length, workflows),
    );
}

function resolveCommandMenuSubmission(line: string, view: SlashCommandMenuView): string {
    const selectedChoice = view.visibleChoices[view.selectedIndex - view.startIndex];
    if (!view.open || selectedChoice === undefined) {
        return line;
    }
    return selectedChoice.insertText.trimEnd();
}

export function resolveSlashCommandMenuSubmission(line: string, state: SlashCommandMenuState): string {
    return resolveCommandMenuSubmission(line, createSlashCommandMenuView(line, state, slashCommandChoices.length));
}

export function resolveWorkflowCommandMenuSubmission(
    line: string,
    state: SlashCommandMenuState,
    workflows: readonly string[],
): string {
    return resolveCommandMenuSubmission(
        line,
        createWorkflowCommandMenuView(line, state, workflowCommandChoices(workflows).length, workflows),
    );
}

/**
 * Raw (untrimmed) insertText of the workflow menu's selected choice.
 *
 * Returns `undefined` when the menu is closed or has no selection. Unlike
 * {@link resolveWorkflowCommandMenuSubmission} the trailing space is kept, so a
 * caller can drop the value into the input buffer and let the user keep typing
 * the prompt argument; that trailing space also closes the menu (a token with a
 * space is rejected by `readCommandQuery`), so the next Enter submits normally.
 */
export function resolveWorkflowCommandMenuInsertText(
    line: string,
    state: SlashCommandMenuState,
    workflows: readonly string[],
): string | undefined {
    const view = createWorkflowCommandMenuView(line, state, workflowCommandChoices(workflows).length, workflows);
    if (!view.open) {
        return undefined;
    }
    const selectedChoice = view.visibleChoices[view.selectedIndex - view.startIndex];
    return selectedChoice?.insertText;
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

function readCommandQuery(line: string, prefix: string): string | undefined {
    if (!line.startsWith(prefix)) {
        return undefined;
    }
    const commandToken = line.slice(prefix.length);
    if (commandToken.includes(' ') || commandToken.includes('\n') || commandToken.includes('\t')) {
        return undefined;
    }
    return commandToken.toLowerCase();
}

function filterCommandChoices(
    query: string,
    choices: readonly SlashCommandMenuChoice[],
): readonly SlashCommandMenuChoice[] {
    if (query.length === 0) {
        return choices;
    }
    return choices.filter(
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
