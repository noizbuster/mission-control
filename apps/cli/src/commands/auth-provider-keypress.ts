export type ProviderPromptKeypressChoice = {
    readonly id: string;
    readonly name: string;
};

export type ProviderPromptKeypressState = {
    readonly selectedIndex: number;
    readonly pendingEscape: string;
    readonly pendingNumberSelection: string;
    readonly searchQuery: string;
    readonly submitted: boolean;
    readonly cancelled: boolean;
};

export type ProviderPromptView = {
    readonly filteredChoices: readonly ProviderPromptKeypressChoice[];
    readonly visibleChoices: readonly ProviderPromptKeypressChoice[];
    readonly selectedIndex: number;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly totalCount: number;
    readonly searchQuery: string;
};

const arrowUpSequence = '\u001b[A';
const arrowDownSequence = '\u001b[B';

export function createProviderPromptKeypressState(): ProviderPromptKeypressState {
    return {
        selectedIndex: 0,
        pendingEscape: '',
        pendingNumberSelection: '',
        searchQuery: '',
        submitted: false,
        cancelled: false,
    };
}

export function reduceProviderPromptKeypress(
    state: ProviderPromptKeypressState,
    chunk: string,
    choices: readonly ProviderPromptKeypressChoice[],
): ProviderPromptKeypressState {
    let nextState = state;
    for (const character of chunk) {
        nextState = reduceProviderPromptKeypressCharacter(nextState, character, choices);
        if (nextState.submitted || nextState.cancelled) {
            return nextState;
        }
    }
    return nextState;
}

export function createProviderPromptView(
    state: ProviderPromptKeypressState,
    choices: readonly ProviderPromptKeypressChoice[],
    maxVisibleChoices: number,
): ProviderPromptView {
    const visibleLimit = Math.max(1, maxVisibleChoices);
    const filteredChoices = filterProviderPromptChoices(choices, state.searchQuery);
    const selectedIndex = clampSelectedIndex(state.selectedIndex, filteredChoices.length);
    const startIndex = getWindowStartIndex(selectedIndex, filteredChoices.length, visibleLimit);
    const endIndex = Math.min(filteredChoices.length, startIndex + visibleLimit);
    return {
        filteredChoices,
        visibleChoices: filteredChoices.slice(startIndex, endIndex),
        selectedIndex,
        startIndex,
        endIndex,
        totalCount: filteredChoices.length,
        searchQuery: state.searchQuery,
    };
}

export function filterProviderPromptChoices(
    choices: readonly ProviderPromptKeypressChoice[],
    searchQuery: string,
): readonly ProviderPromptKeypressChoice[] {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
        return choices;
    }
    return choices.filter(
        (choice) =>
            choice.id.toLowerCase().includes(normalizedQuery) || choice.name.toLowerCase().includes(normalizedQuery),
    );
}

function reduceProviderPromptKeypressCharacter(
    state: ProviderPromptKeypressState,
    character: string,
    choices: readonly ProviderPromptKeypressChoice[],
): ProviderPromptKeypressState {
    if (state.submitted || state.cancelled) {
        return state;
    }
    if (state.pendingEscape.length > 0) {
        return reducePendingEscape(state, character, choices);
    }
    if (state.pendingNumberSelection.length > 0) {
        return reducePendingNumberSelection(state, character, choices);
    }
    if (character === '\u001b') {
        return { ...state, pendingEscape: character };
    }
    if (character === '\u0003') {
        return { ...state, cancelled: true, pendingEscape: '' };
    }
    if (character === '\r' || character === '\n') {
        return submitSelection(state, choices);
    }
    if (character === '\u0015') {
        return { ...state, searchQuery: '', selectedIndex: 0, pendingNumberSelection: '' };
    }
    if (character === '\b' || character === '\u007f') {
        return removeSearchCharacter(state);
    }
    if (character === 'j') {
        return moveSelection(state, choices, 1);
    }
    if (character === 'k') {
        return moveSelection(state, choices, -1);
    }
    if (/^[0-9]$/.test(character) && state.searchQuery.length === 0) {
        return { ...state, pendingNumberSelection: character };
    }
    if (isSearchCharacter(character)) {
        return appendSearchQuery(state, character);
    }
    return state;
}

function reducePendingNumberSelection(
    state: ProviderPromptKeypressState,
    character: string,
    choices: readonly ProviderPromptKeypressChoice[],
): ProviderPromptKeypressState {
    if (character === '\r' || character === '\n') {
        const selectedIndex = Number.parseInt(state.pendingNumberSelection, 10) - 1;
        if (selectedIndex < 0 || selectedIndex >= choices.length) {
            return { ...state, pendingNumberSelection: '' };
        }
        return { ...state, selectedIndex, submitted: true, pendingNumberSelection: '' };
    }
    if (character === '\b' || character === '\u007f') {
        return { ...state, pendingNumberSelection: '' };
    }
    if (isSearchCharacter(character)) {
        return appendSearchQuery(
            { ...state, pendingNumberSelection: '' },
            `${state.pendingNumberSelection}${character}`,
        );
    }
    return reduceProviderPromptKeypressCharacter({ ...state, pendingNumberSelection: '' }, character, choices);
}

function reducePendingEscape(
    state: ProviderPromptKeypressState,
    character: string,
    choices: readonly ProviderPromptKeypressChoice[],
): ProviderPromptKeypressState {
    const sequence = `${state.pendingEscape}${character}`;
    if (sequence === arrowDownSequence) {
        return moveSelection({ ...state, pendingEscape: '' }, choices, 1);
    }
    if (sequence === arrowUpSequence) {
        return moveSelection({ ...state, pendingEscape: '' }, choices, -1);
    }
    if (arrowDownSequence.startsWith(sequence) || arrowUpSequence.startsWith(sequence)) {
        return { ...state, pendingEscape: sequence };
    }
    return reduceProviderPromptKeypressCharacter({ ...state, pendingEscape: '' }, character, choices);
}

function moveSelection(
    state: ProviderPromptKeypressState,
    choices: readonly ProviderPromptKeypressChoice[],
    direction: 1 | -1,
): ProviderPromptKeypressState {
    const filteredChoiceCount = filterProviderPromptChoices(choices, state.searchQuery).length;
    if (filteredChoiceCount <= 0) {
        return { ...state, pendingNumberSelection: '' };
    }
    return {
        ...state,
        selectedIndex: (state.selectedIndex + filteredChoiceCount + direction) % filteredChoiceCount,
        pendingEscape: '',
        pendingNumberSelection: '',
    };
}

function submitSelection(
    state: ProviderPromptKeypressState,
    choices: readonly ProviderPromptKeypressChoice[],
): ProviderPromptKeypressState {
    if (filterProviderPromptChoices(choices, state.searchQuery).length === 0) {
        return state;
    }
    return { ...state, submitted: true, pendingEscape: '', pendingNumberSelection: '' };
}

function appendSearchQuery(state: ProviderPromptKeypressState, value: string): ProviderPromptKeypressState {
    return {
        ...state,
        searchQuery: `${state.searchQuery}${value}`,
        selectedIndex: 0,
        pendingEscape: '',
        pendingNumberSelection: '',
    };
}

function removeSearchCharacter(state: ProviderPromptKeypressState): ProviderPromptKeypressState {
    if (state.searchQuery.length === 0) {
        return state;
    }
    return {
        ...state,
        searchQuery: state.searchQuery.slice(0, -1),
        selectedIndex: 0,
        pendingNumberSelection: '',
    };
}

function isSearchCharacter(character: string): boolean {
    return character >= ' ' && character !== '\u007f';
}

function clampSelectedIndex(selectedIndex: number, choiceCount: number): number {
    if (choiceCount <= 0) {
        return 0;
    }
    return Math.min(Math.max(selectedIndex, 0), choiceCount - 1);
}

function getWindowStartIndex(selectedIndex: number, choiceCount: number, visibleLimit: number): number {
    if (choiceCount <= visibleLimit) {
        return 0;
    }
    const centeredStart = selectedIndex - Math.floor(visibleLimit / 2);
    return Math.min(Math.max(centeredStart, 0), choiceCount - visibleLimit);
}
