import { modelProviderCatalog } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

type AuthPrompt = (message: string) => Promise<string>;

type AuthPromptSession = {
    readonly prompt: AuthPrompt;
    readonly promptSecret: AuthPrompt;
    readonly close: () => void;
};

export type AuthCommandOptions = {
    readonly store?: ProviderAuthStore;
    readonly now?: string;
    readonly prompt?: AuthPrompt;
    readonly promptSecret?: AuthPrompt;
};

export async function runAuthCommand(args: CliArgs, options: AuthCommandOptions = {}): Promise<string> {
    switch (args.command) {
        case 'auth-login':
            return runAuthLogin(args, options);
        case 'auth-list':
            return runAuthList(options.store ?? createProviderAuthStore());
        case 'auth-logout':
            return runAuthLogout(args, options.store ?? createProviderAuthStore());
        default:
            throw new Error(`Unsupported auth command: ${args.command}`);
    }
}

async function runAuthLogin(args: CliArgs, options: AuthCommandOptions): Promise<string> {
    const needsPrompt = args.authProviderID === undefined || args.authApiKey === undefined;
    const promptSession =
        options.prompt === undefined && options.promptSecret === undefined && needsPrompt
            ? createPromptSession()
            : undefined;
    const prompt = options.prompt ?? promptSession?.prompt;
    const promptSecret = options.promptSecret ?? options.prompt ?? promptSession?.promptSecret;

    try {
        const providerID = await resolvePromptedValue(args.authProviderID, 'provider', prompt);
        if (providerID.length === 0) {
            throw new Error('auth login requires --provider');
        }

        const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
        if (provider === undefined) {
            throw new Error(`Unknown provider: ${providerID}`);
        }

        const modelID = args.authModelID ?? provider.defaultModelID;
        const selection = validateProviderModelSelection({
            providerID: provider.id,
            modelID,
        });
        const apiKey = await resolvePromptedValue(args.authApiKey, provider.authLabel, promptSecret);
        if (apiKey.length === 0) {
            throw new Error('auth login requires --api-key');
        }

        const store = options.store ?? createProviderAuthStore();
        await store.saveCredential({
            providerID: selection.providerID,
            modelID: selection.modelID,
            apiKey,
            now: options.now ?? new Date().toISOString(),
        });
        const summary = (await store.listCredentialSummaries()).find(
            (entry) => entry.providerID === selection.providerID,
        );
        const maskedCredential = summary?.maskedCredential ?? '********';
        return [
            `Logged in ${selection.providerID}`,
            `default: ${selection.providerID}/${selection.modelID}`,
            `credential: ${maskedCredential}`,
            '',
        ].join('\n');
    } finally {
        promptSession?.close();
    }
}

async function runAuthList(store: ProviderAuthStore): Promise<string> {
    const summaries = await store.listCredentialSummaries();
    if (summaries.length === 0) {
        return 'No provider credentials configured\n';
    }
    const summaryByProvider = new Map(summaries.map((summary) => [summary.providerID, summary]));
    const lines = modelProviderCatalog
        .map((provider) => summaryByProvider.get(provider.id))
        .filter(isDefined)
        .map((summary) => `${summary.providerID} ${summary.maskedCredential ?? '********'}`);
    return ['Authenticated providers', ...lines, ''].join('\n');
}

async function runAuthLogout(args: CliArgs, store: ProviderAuthStore): Promise<string> {
    const providerID = args.authProviderID;
    if (providerID === undefined) {
        throw new Error('auth logout requires --provider');
    }
    validateProviderID(providerID);
    await store.deleteCredential(providerID);
    return `Logged out ${providerID}\n`;
}

function validateProviderID(providerID: string): void {
    if (!modelProviderCatalog.some((entry) => entry.id === providerID)) {
        throw new Error(`Unknown provider: ${providerID}`);
    }
}

function validateProviderModelSelection(selection: ModelProviderSelection): ModelProviderSelection {
    const provider = modelProviderCatalog.find((entry) => entry.id === selection.providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${selection.providerID}`);
    }
    if (!provider.models.some((model) => model.id === selection.modelID)) {
        throw new Error(`Model ${selection.modelID} is not available for provider ${selection.providerID}`);
    }
    return selection;
}

async function resolvePromptedValue(
    value: string | undefined,
    label: string,
    prompt: AuthPrompt | undefined,
): Promise<string> {
    if (value !== undefined) {
        return value.trim();
    }
    if (prompt === undefined) {
        throw new Error(`auth login requires ${label}`);
    }
    return (await prompt(label)).trim();
}

function createPromptSession(): AuthPromptSession {
    if (input.isTTY !== true) {
        return createPipedPromptSession();
    }

    return {
        prompt: questionLine,
        promptSecret: questionSecretLine,
        close: () => {},
    };
}

function createPipedPromptSession(): AuthPromptSession {
    const answers = readInputLines(input);
    let index = 0;
    return {
        prompt: async (message) => {
            output.write(`${message}: `);
            const lines = await answers;
            const answer = lines[index] ?? '';
            index += 1;
            return answer;
        },
        promptSecret: async (message) => {
            output.write(`${message}: `);
            const lines = await answers;
            const answer = lines[index] ?? '';
            index += 1;
            return answer;
        },
        close: () => {},
    };
}

async function questionLine(message: string): Promise<string> {
    const readline = createInterface({ input, output });
    try {
        return await readline.question(`${message}: `);
    } finally {
        readline.close();
    }
}

async function questionSecretLine(message: string): Promise<string> {
    output.write(`${message}: `);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();

    return new Promise((resolve, reject) => {
        const characters: string[] = [];

        function cleanup(): void {
            input.off('data', onData);
            input.setRawMode(wasRaw);
        }

        function finish(): void {
            cleanup();
            output.write('\n');
            resolve(characters.join(''));
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
                    characters.pop();
                    continue;
                }
                characters.push(character);
            }
        }

        input.on('data', onData);
    });
}

async function readInputLines(stream: AsyncIterable<Buffer | string>): Promise<readonly string[]> {
    let data = '';
    for await (const chunk of stream) {
        data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }
    return data.replace(/\r\n/g, '\n').split('\n');
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
