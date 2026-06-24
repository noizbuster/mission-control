import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    filterProviderPromptChoices,
    type ProviderPromptKeypressChoice,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

export type AuthPromptOptions = {
    readonly defaultValue?: string;
    readonly defaultValueSource?: string;
    readonly defaultValuePreview?: string;
};

export type AuthPrompt = (message: string, options?: AuthPromptOptions) => Promise<string>;

export type ProviderPromptChoice = ProviderPromptKeypressChoice;

export type AuthProviderPrompt = (message: string, choices: readonly ProviderPromptChoice[]) => Promise<string>;

export function maskSecretHint(value: string): string {
    if (value.length <= 6) {
        return '***';
    }
    const head = value.slice(0, 3);
    const tail = value.slice(-3);
    const middleLength = value.length - 6;
    return `${head}${'*'.repeat(middleLength)}${tail}`;
}

function formatPromptMessage(message: string, options: AuthPromptOptions | undefined): string {
    if (options?.defaultValue === undefined || options.defaultValue.length === 0) {
        return message;
    }
    const source =
        options.defaultValueSource !== undefined && options.defaultValueSource.length > 0
            ? options.defaultValueSource
            : 'default';
    const preview = options.defaultValuePreview;
    if (preview !== undefined && preview.length > 0) {
        return `${message} (${preview}, press Enter to use ${source})`;
    }
    return `${message} (press Enter to use ${source})`;
}

function resolvePromptResult(value: string, options: AuthPromptOptions | undefined): string {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
        return trimmed;
    }
    return options?.defaultValue ?? '';
}

export type AuthPromptSession = {
    readonly prompt: AuthPrompt;
    readonly promptSecret: AuthPrompt;
    readonly promptProvider: AuthProviderPrompt;
    readonly close: () => void;
};

export function createPromptSession(): AuthPromptSession {
    if (input.isTTY !== true) {
        return createPipedPromptSession();
    }

    return {
        prompt: questionLine,
        promptSecret: questionSecretLine,
        promptProvider: questionProviderLine,
        close: () => {},
    };
}

export function isPromptInputTTY(): boolean {
    return input.isTTY === true;
}

export function resolveProviderChoiceInput(value: string, choices: readonly ProviderPromptChoice[]): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return '';
    }

    const numberedChoice = resolveNumberedProviderChoice(trimmed, choices);
    if (numberedChoice !== undefined) {
        return numberedChoice;
    }

    const lowerInput = trimmed.toLowerCase();
    const namedChoice = choices.find((choice) => choice.id === trimmed || choice.name.toLowerCase() === lowerInput);
    if (namedChoice !== undefined) {
        return namedChoice.id;
    }

    const filteredChoices = filterProviderPromptChoices(choices, trimmed);
    const filteredChoice = filteredChoices[0];
    if (filteredChoices.length === 1 && filteredChoice !== undefined) {
        return filteredChoice.id;
    }

    throw new Error('Unknown provider selection');
}

function createPipedPromptSession(): AuthPromptSession {
    const answers = readInputLines(input);
    let index = 0;

    async function readNextAnswer(): Promise<string> {
        const lines = await answers;
        const answer = lines[index] ?? '';
        index += 1;
        return answer;
    }

    return {
        prompt: async (message, options) => {
            output.write(`${formatPromptMessage(message, options)}: `);
            return resolvePromptResult(await readNextAnswer(), options);
        },
        promptSecret: async (message, options) => {
            output.write(`${formatPromptMessage(message, options)}: `);
            return resolvePromptResult(await readNextAnswer(), options);
        },
        promptProvider: async (message, choices) => {
            output.write(`${message}:\n`);
            for (const [choiceIndex, choice] of choices.entries()) {
                output.write(`  ${choiceIndex + 1}. ${choice.name} (${choice.id})\n`);
            }
            output.write('provider: ');
            return resolveProviderChoiceInput(await readNextAnswer(), choices);
        },
        close: () => {},
    };
}

function resolveNumberedProviderChoice(value: string, choices: readonly ProviderPromptChoice[]): string | undefined {
    if (!/^[0-9]+$/.test(value)) {
        return undefined;
    }
    const providerIndex = Number.parseInt(value, 10) - 1;
    return choices[providerIndex]?.id;
}

async function questionLine(message: string, options?: AuthPromptOptions): Promise<string> {
    const label = formatPromptMessage(message, options);
    const readline = createInterface({ input, output });
    try {
        return resolvePromptResult(await readline.question(`${label}: `), options);
    } finally {
        readline.close();
    }
}

async function questionSecretLine(message: string, options?: AuthPromptOptions): Promise<string> {
    const label = formatPromptMessage(message, options);
    output.write(`${label}: `);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();

    return new Promise((resolve, reject) => {
        const characters: string[] = [];

        function cleanup(): void {
            input.off('data', onData);
            input.setRawMode(wasRaw);
            input.pause();
        }

        function finish(): void {
            cleanup();
            output.write('\n');
            resolve(resolvePromptResult(characters.join(''), options));
        }

        function onData(chunk: Buffer | string): void {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            for (const character of text) {
                if (character === '\u0003') {
                    cleanup();
                    output.write('\n');
                    reject(new Error('auth login cancelled'));
                    return;
                }
                if (character === '\n' || character === '\r') {
                    finish();
                    return;
                }
                if (character === '\b' || character === '\u007f') {
                    if (characters.pop() !== undefined) {
                        output.write('\b \b');
                    }
                    continue;
                }
                characters.push(character);
                output.write('*');
            }
        }

        input.on('data', onData);
    });
}

async function questionProviderLine(message: string, choices: readonly ProviderPromptChoice[]): Promise<string> {
    if (choices.length === 0) {
        throw new Error('No supported providers are configured');
    }

    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();

    return new Promise((resolve, reject) => {
        let keypressState = createProviderPromptKeypressState();
        let renderedLines = 0;

        function clearPreviousRender(): void {
            if (renderedLines > 0) {
                output.write(`\u001b[${renderedLines}F\u001b[0J`);
            }
        }

        function render(): void {
            clearPreviousRender();
            const view = createProviderPromptView(keypressState, choices, getVisibleProviderChoiceCount());
            output.write(`${message}\n`);
            output.write(`Search: ${view.searchQuery}\n`);
            if (view.totalCount === 0) {
                output.write('No providers match\n');
            } else {
                output.write(`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}\n`);
            }
            for (const [visibleIndex, choice] of view.visibleChoices.entries()) {
                const choiceIndex = view.startIndex + visibleIndex;
                const marker = choiceIndex === view.selectedIndex ? '>' : ' ';
                output.write(`${marker} ${choiceIndex + 1}. ${choice.name} (${choice.id})\n`);
            }
            output.write('Use Up/Down, type to search, Enter to select\n');
            renderedLines = 4 + view.visibleChoices.length;
        }

        function cleanup(): void {
            input.off('data', onData);
            input.setRawMode(wasRaw);
            input.pause();
        }

        function finish(): void {
            cleanup();
            output.write('\n');
            const view = createProviderPromptView(keypressState, choices, getVisibleProviderChoiceCount());
            resolve(view.filteredChoices[view.selectedIndex]?.id ?? '');
        }

        function onData(chunk: Buffer | string): void {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const nextState = reduceProviderPromptKeypress(keypressState, text, choices);
            const shouldRender = shouldRenderProviderPrompt(keypressState, nextState);
            keypressState = nextState;

            if (keypressState.cancelled) {
                cleanup();
                output.write('\n');
                reject(new Error('auth login cancelled'));
                return;
            }
            if (shouldRender) {
                render();
            }
            if (keypressState.submitted) {
                finish();
            }
        }

        render();
        input.on('data', onData);
    });
}

function shouldRenderProviderPrompt(
    previous: ReturnType<typeof createProviderPromptKeypressState>,
    next: ReturnType<typeof createProviderPromptKeypressState>,
): boolean {
    return previous.selectedIndex !== next.selectedIndex || previous.searchQuery !== next.searchQuery;
}

function getVisibleProviderChoiceCount(): number {
    const terminalRows = output.rows;
    if (terminalRows === undefined) {
        return 12;
    }
    return Math.min(12, Math.max(5, terminalRows - 5));
}

async function readInputLines(stream: AsyncIterable<Buffer | string>): Promise<readonly string[]> {
    let data = '';
    for await (const chunk of stream) {
        data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }
    return data.replace(/\r\n/g, '\n').split('\n');
}
