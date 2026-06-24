import type { ModelProviderSelection } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createProviderPromptKeypressState, createProviderPromptView } from './auth-provider-keypress.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { createTerminalModelSelectorFromStreams, renderModelSelectorLines } from './interactive-chat-model-selector.js';
import { terminalDisplayWidth } from './terminal-text.js';
import { EventEmitter } from 'node:events';

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

class FakeModelPickerInput extends EventEmitter {
    isRaw = false;
    isPaused = true;

    setRawMode(isRaw: boolean): void {
        this.isRaw = isRaw;
    }

    resume(): void {
        this.isPaused = false;
    }

    pause(): void {
        this.isPaused = true;
    }

    send(chunk: Buffer | string): void {
        this.emit('data', chunk);
    }
}

class FakeModelPickerOutput {
    private readonly chunks: string[] = [];
    readonly rows = 24;
    readonly columns = 80;

    write(text: string): void {
        this.chunks.push(text);
    }

    getOutput(): string {
        return this.chunks.join('');
    }
}

const localVariantChoices: readonly ModelChoice[] = [
    {
        id: 'local/local-echo',
        label: 'local/local-echo [executable]',
        selection: { providerID: 'local', modelID: 'local-echo' },
        capabilityStatus: 'executable',
        availableForCoding: true,
    },
    {
        id: 'local/local-echo#fast',
        label: 'local/local-echo#fast [executable]',
        selection: { providerID: 'local', modelID: 'local-echo', variantID: 'fast' },
        capabilityStatus: 'executable',
        availableForCoding: true,
    },
    {
        id: 'local/local-echo#reasoning-low',
        label: 'local/local-echo#reasoning-low [executable]',
        selection: { providerID: 'local', modelID: 'local-echo', variantID: 'reasoning-low' },
        capabilityStatus: 'executable',
        availableForCoding: true,
    },
];

const defaultModelSelection: ModelProviderSelection = {
    providerID: 'local',
    modelID: 'local-echo',
};

describe('terminal model selector stream ownership', () => {
    it('cancels the terminal model picker on Ctrl+C and detaches stdin', async () => {
        const input = new FakeModelPickerInput();
        const output = new FakeModelPickerOutput();
        const chatOutput = { write: (text: string) => output.write(text) };
        const selectModel = createTerminalModelSelectorFromStreams(chatOutput, { input, output });

        const selectionPromise = selectModel(localVariantChoices, defaultModelSelection, { title: 'Select model' });

        input.send('\u0003');

        const selection = await selectionPromise;

        expect(selection).toBeUndefined();
        expect(input.listenerCount('data')).toBe(0);
        expect(input.isRaw).toBe(false);
        expect(input.isPaused).toBe(true);
        expect(output.getOutput()).toContain('Select model');
    });

    it('moves exactly one row for one Down arrow before Enter', async () => {
        const input = new FakeModelPickerInput();
        const output = new FakeModelPickerOutput();
        const chatOutput = { write: (text: string) => output.write(text) };
        const selectModel = createTerminalModelSelectorFromStreams(chatOutput, { input, output });

        const selectionPromise = selectModel(localVariantChoices, defaultModelSelection, { title: 'Select model' });

        input.send('\u001b[B');
        input.send('\r');

        const selection = await selectionPromise;

        expect(selection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'fast',
        });
        expect(input.listenerCount('data')).toBe(0);
    });

    it('detaches the data listener after Enter submit', async () => {
        const input = new FakeModelPickerInput();
        const output = new FakeModelPickerOutput();
        const chatOutput = { write: (text: string) => output.write(text) };
        const selectModel = createTerminalModelSelectorFromStreams(chatOutput, { input, output });

        const selectionPromise = selectModel(localVariantChoices, defaultModelSelection, { title: 'Select model' });

        input.send('\r');

        await selectionPromise;
        expect(input.listenerCount('data')).toBe(0);
    });
});
