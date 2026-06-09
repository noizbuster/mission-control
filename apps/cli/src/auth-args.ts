import type { AuthCredentialArg, CliArgs } from './args.js';

type AuthCliCommand = Extract<CliArgs['command'], 'auth-login' | 'auth-list' | 'auth-logout'>;

export function parseAuthArgs(argv: readonly string[]): CliArgs {
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
            throw new Error(
                subcommand === undefined ? 'Unsupported auth command: missing' : 'Unsupported auth command',
            );
    }
}

function parseAuthLoginArgs(argv: readonly string[]): CliArgs {
    let providerID: string | undefined;
    let modelID: string | undefined;
    let methodID: string | undefined;
    let apiKey: string | undefined;
    const credentials: AuthCredentialArg[] = [];
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
            case '--method':
            case '-m':
                methodID = readFlagValue(argv, index, current);
                index += 2;
                break;
            case '--credential':
                credentials.push(parseCredentialFlag(readFlagValue(argv, index, '--credential')));
                index += 2;
                break;
            default:
                throw new Error('Unsupported auth login argument');
        }
    }

    return {
        ...createBaseArgs('auth-login'),
        ...(providerID !== undefined ? { authProviderID: providerID } : {}),
        ...(modelID !== undefined ? { authModelID: modelID } : {}),
        ...(methodID !== undefined ? { authMethodID: methodID } : {}),
        ...(apiKey !== undefined ? { authApiKey: apiKey } : {}),
        ...(credentials.length > 0 ? { authCredentials: credentials } : {}),
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
            default:
                throw new Error('Unsupported auth logout argument');
        }
    }

    return {
        ...createBaseArgs('auth-logout'),
        ...(providerID !== undefined ? { authProviderID: providerID } : {}),
    };
}

function createBaseArgs(command: AuthCliCommand): CliArgs {
    return {
        mode: 'ink',
        useNative: undefined,
        command,
        showHelp: false,
        showVersion: false,
    };
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function parseCredentialFlag(value: string): AuthCredentialArg {
    const separatorIndex = value.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        throw new Error('--credential requires FIELD=VALUE');
    }
    return {
        fieldID: value.slice(0, separatorIndex),
        value: value.slice(separatorIndex + 1),
    };
}
