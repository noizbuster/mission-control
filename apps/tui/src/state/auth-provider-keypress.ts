import {
    areEquivalentPromptArrowKeypresses,
    isCompletePromptControlSequence,
    isPendingPromptControlSequence,
    type PromptArrowKeypress,
    readPromptControlArrowKeypress,
} from './auth-provider-keypress-escape.js';
import type { ProviderPromptKeypressChoice, ProviderPromptKeypressState } from './auth-provider-keypress-types.js';
import { filterProviderPromptChoices } from './auth-provider-keypress-view.js';
import { isTerminalInterruptToken } from './interactive-chat-terminal-keys.js';

export type {
    ProviderPromptKeypressChoice,
    ProviderPromptKeypressState,
    ProviderPromptView,
} from './auth-provider-keypress-types.js';
export { createProviderPromptView, filterProviderPromptChoices } from './auth-provider-keypress-view.js';

type ProviderPromptKeypressReduction = {
    readonly state: ProviderPromptKeypressState;
    readonly arrowKeypress?: PromptArrowKeypress;
    readonly keepArrowCoalescing?: boolean;
};

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
    let lastArrowKeypress = state.lastArrowKeypress;
    for (const character of chunk) {
        const reduction = reduceProviderPromptKeypressCharacter(nextState, character, choices, lastArrowKeypress);
        nextState = withoutLastArrowKeypress(reduction.state);
        if (reduction.arrowKeypress !== undefined) {
            lastArrowKeypress = reduction.arrowKeypress;
        } else if (reduction.keepArrowCoalescing !== true) {
            lastArrowKeypress = undefined;
        }
        if (nextState.submitted || nextState.cancelled) {
            return nextState;
        }
    }
    return withLastArrowKeypress(nextState, lastArrowKeypress);
}

function reduceProviderPromptKeypressCharacter(
    state: ProviderPromptKeypressState,
    character: string,
    choices: readonly ProviderPromptKeypressChoice[],
    lastArrowKeypress?: PromptArrowKeypress,
): ProviderPromptKeypressReduction {
    if (state.submitted || state.cancelled) {
        return { state };
    }
    if (state.pendingEscape.length > 0) {
        return reducePendingEscape(state, character, choices, lastArrowKeypress);
    }
    if (state.pendingNumberSelection.length > 0) {
        return { state: reducePendingNumberSelection(state, character, choices) };
    }
    if (character === '\u001b') {
        return { state: { ...state, pendingEscape: character }, keepArrowCoalescing: true };
    }
    if (isTerminalInterruptToken(character)) {
        return { state: { ...state, cancelled: true, pendingEscape: '' } };
    }
    if (character === '\r' || character === '\n') {
        return { state: submitSelection(state, choices) };
    }
    if (character === '\u0015') {
        return { state: { ...state, searchQuery: '', selectedIndex: 0, pendingNumberSelection: '' } };
    }
    if (character === '\b' || character === '\u007f') {
        return { state: removeSearchCharacter(state) };
    }
    if (character === 'j') {
        return { state: moveSelection(state, choices, 1) };
    }
    if (character === 'k') {
        return { state: moveSelection(state, choices, -1) };
    }
    if (/^[0-9]$/.test(character) && state.searchQuery.length === 0) {
        return { state: { ...state, pendingNumberSelection: character } };
    }
    if (isSearchCharacter(character)) {
        return { state: appendSearchQuery(state, character) };
    }
    return { state };
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
    return reduceProviderPromptKeypressCharacter({ ...state, pendingNumberSelection: '' }, character, choices).state;
}

function reducePendingEscape(
    state: ProviderPromptKeypressState,
    character: string,
    choices: readonly ProviderPromptKeypressChoice[],
    lastArrowKeypress?: PromptArrowKeypress,
): ProviderPromptKeypressReduction {
    const sequence = `${state.pendingEscape}${character}`;
    if (isTerminalInterruptToken(sequence)) {
        return { state: { ...state, cancelled: true, pendingEscape: '' } };
    }
    const arrowKeypress = readPromptControlArrowKeypress(sequence);
    if (arrowKeypress !== undefined) {
        if (lastArrowKeypress !== undefined && areEquivalentPromptArrowKeypresses(lastArrowKeypress, arrowKeypress)) {
            return { state: { ...state, pendingEscape: '' } };
        }
        return {
            state: moveSelection({ ...state, pendingEscape: '' }, choices, arrowKeypress.direction),
            arrowKeypress,
        };
    }
    if (isPendingPromptControlSequence(sequence)) {
        return { state: { ...state, pendingEscape: sequence }, keepArrowCoalescing: true };
    }
    if (isCompletePromptControlSequence(sequence)) {
        return { state: { ...state, pendingEscape: '' } };
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

function withLastArrowKeypress(
    state: ProviderPromptKeypressState,
    lastArrowKeypress: PromptArrowKeypress | undefined,
): ProviderPromptKeypressState {
    if (lastArrowKeypress === undefined) {
        return state;
    }
    return { ...state, lastArrowKeypress };
}

function withoutLastArrowKeypress(state: ProviderPromptKeypressState): ProviderPromptKeypressState {
    return {
        selectedIndex: state.selectedIndex,
        pendingEscape: state.pendingEscape,
        pendingNumberSelection: state.pendingNumberSelection,
        searchQuery: state.searchQuery,
        submitted: state.submitted,
        cancelled: state.cancelled,
    };
}
