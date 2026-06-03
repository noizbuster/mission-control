import type { ModelProviderSelection } from '@mission-control/protocol';

export type CliMode = 'ink' | 'plain' | 'json';

export type CliCommand = 'run' | 'auth-login' | 'auth-list' | 'auth-logout' | 'models';

export type CliArgs = {
    readonly mode: CliMode;
    readonly useNative: boolean | undefined;
    readonly command: CliCommand;
    readonly showHelp: boolean;
    readonly showVersion: boolean;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly authProviderID?: string;
    readonly authModelID?: string;
    readonly authApiKey?: string;
    readonly modelsProviderID?: string;
};

export const supportedCliFlags = [
    '--ui',
    '--no-tui',
    '--json',
    '--native',
    '--no-native',
    '--provider',
    '--model',
    '--api-key',
    '--version',
    '--help',
] as const;

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function resolveModelProviderSelection(
    providerID: string | undefined,
    modelID: string | undefined,
): ModelProviderSelection | undefined {
    if (providerID === undefined && modelID === undefined) {
        return undefined;
    }
    if (providerID !== undefined && modelID === undefined) {
        throw new Error('--provider requires --model');
    }
    if (modelID === undefined) {
        return undefined;
    }
    const slashIndex = modelID.indexOf('/');
    if (providerID !== undefined) {
        if (slashIndex >= 0) {
            throw new Error('--model provider/model cannot be combined with --provider');
        }
        return { providerID, modelID };
    }
    if (slashIndex <= 0 || slashIndex === modelID.length - 1) {
        throw new Error('--model without --provider must use provider/model');
    }
    return {
        providerID: modelID.slice(0, slashIndex),
        modelID: modelID.slice(slashIndex + 1),
    };
}

function createBaseArgs(command: CliCommand): Omit<CliArgs, 'modelProviderSelection'> {
    return {
        mode: 'ink',
        useNative: undefined,
        command,
        showHelp: false,
        showVersion: false,
    };
}

export function parseArgs(argv: readonly string[]): CliArgs {
    const command = argv[0];
    if (command === 'auth') {
        return parseAuthArgs(argv.slice(1));
    }
    if (command === 'models') {
        return parseModelsArgs(argv.slice(1));
    }

    let mode: CliMode = 'ink';
    let useNative: boolean | undefined;
    let showHelp = false;
    let showVersion = false;
    let providerID: string | undefined;
    let modelID: string | undefined;
    let index = 0;

    while (index < argv.length) {
        const current = argv[index];
        switch (current) {
            case '--ui': {
                const value = argv[index + 1];
                if (value !== 'ink') {
                    throw new Error('--ui only supports ink');
                }
                mode = 'ink';
                index += 2;
                break;
            }
            case '--no-tui':
                mode = 'plain';
                index += 1;
                break;
            case '--json':
                mode = 'json';
                index += 1;
                break;
            case '--native':
                useNative = true;
                index += 1;
                break;
            case '--no-native':
                useNative = false;
                index += 1;
                break;
            case '--provider':
                providerID = readFlagValue(argv, index, '--provider');
                index += 2;
                break;
            case '--model':
                modelID = readFlagValue(argv, index, '--model');
                index += 2;
                break;
            case '--version':
                showVersion = true;
                index += 1;
                break;
            case '--help':
                showHelp = true;
                index += 1;
                break;
            case undefined:
                index += 1;
                break;
            default:
                throw new Error(`Unsupported argument: ${current}`);
        }
    }

    const baseArgs = {
        mode,
        useNative,
        command: 'run',
        showHelp,
        showVersion,
    } satisfies CliArgs;
    const modelProviderSelection = resolveModelProviderSelection(providerID, modelID);
    if (modelProviderSelection === undefined) {
        return baseArgs;
    }
    return {
        ...baseArgs,
        modelProviderSelection,
    };
}

function parseAuthArgs(argv: readonly string[]): CliArgs {
    const subcommand = argv[0];
    switch (subcommand) {
        case 'login':
            return parseAuthLoginArgs(argv.slice(1));
        case 'list':
        case 'ls':
            return createBaseArgs('auth-list');
        case 'logout':
            return parseAuthLogoutArgs(argv.slice(1));
        default:
            throw new Error(`Unsupported auth command: ${subcommand ?? 'missing'}`);
    }
}

function parseAuthLoginArgs(argv: readonly string[]): CliArgs {
    let providerID: string | undefined;
    let modelID: string | undefined;
    let apiKey: string | undefined;
    let index = 0;

    while (index < argv.length) {
        const current = argv[index];
        switch (current) {
            case '--provider':
            case '-p':
                providerID = readFlagValue(argv, index, current);
                index += 2;
                break;
            case '--model':
                modelID = readFlagValue(argv, index, '--model');
                index += 2;
                break;
            case '--api-key':
                apiKey = readFlagValue(argv, index, '--api-key');
                index += 2;
                break;
            case undefined:
                index += 1;
                break;
            default:
                throw new Error(`Unsupported auth login argument: ${current}`);
        }
    }

    return {
        ...createBaseArgs('auth-login'),
        ...(providerID !== undefined ? { authProviderID: providerID } : {}),
        ...(modelID !== undefined ? { authModelID: modelID } : {}),
        ...(apiKey !== undefined ? { authApiKey: apiKey } : {}),
    };
}

function parseAuthLogoutArgs(argv: readonly string[]): CliArgs {
    let providerID: string | undefined;
    let index = 0;

    while (index < argv.length) {
        const current = argv[index];
        switch (current) {
            case '--provider':
            case '-p':
                providerID = readFlagValue(argv, index, current);
                index += 2;
                break;
            case undefined:
                index += 1;
                break;
            default:
                throw new Error(`Unsupported auth logout argument: ${current}`);
        }
    }

    if (providerID === undefined) {
        throw new Error('auth logout requires --provider');
    }

    return {
        ...createBaseArgs('auth-logout'),
        authProviderID: providerID,
    };
}

function parseModelsArgs(argv: readonly string[]): CliArgs {
    const providerID = argv[0];
    const extra = argv[1];
    if (extra !== undefined) {
        throw new Error(`Unsupported models argument: ${extra}`);
    }
    return {
        ...createBaseArgs('models'),
        ...(providerID !== undefined ? { modelsProviderID: providerID } : {}),
    };
}
