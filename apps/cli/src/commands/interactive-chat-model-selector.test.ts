import { describe, expect, it } from 'vitest';
import { createProviderPromptKeypressState, createProviderPromptView } from './auth-provider-keypress.js';
import { renderModelSelectorLines } from './interactive-chat-model-selector.js';
import { terminalDisplayWidth } from './terminal-text.js';

describe('terminal model selector renderer', () => {
    it('truncates rendered picker lines to the terminal width', () => {
        const view = createProviderPromptView(createProviderPromptKeypressState(), longChoices, 12);

        const lines = renderModelSelectorLines({
            title: 'Select model',
            view,
            columns: 80,
        });

        expect(lines.every((line) => terminalDisplayWidth(line) <= 80)).toBe(true);
        const choiceLine = lines.find((line) => line.startsWith('> 1. openai/some-extremely-long-provider-model-name'));
        expect(choiceLine).toBeDefined();
        expect(choiceLine?.endsWith('~')).toBe(true);
    });
});

const longChoices = [
    {
        id: 'openai/some-extremely-long-provider-model-name-that-would-wrap-an-80-column-terminal',
        name: 'openai/some-extremely-long-provider-model-name-that-would-wrap-an-80-column-terminal',
    },
] as const;
