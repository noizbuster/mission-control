import type { PromptArrowKeypress } from './auth-provider-keypress-escape.js';

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
    readonly lastArrowKeypress?: PromptArrowKeypress;
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
