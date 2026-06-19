import type { CliArgs } from './args.js';

export type McpSubcommand = 'add' | 'list' | 'remove' | 'test';
export type McpScope = 'project' | 'user';

export type McpKeyValueArg = {
    readonly key: string;
    readonly value: string;
};

type McpCliCommand = Extract<CliArgs['command'], 'mcp-add' | 'mcp-list' | 'mcp-remove' | 'mcp-test'>;

export function parseMcpArgs(argv: readonly string[]): CliArgs {
    const subcommand = argv[0];
    switch (subcommand) {
        case 'add':
            return parseMcpAddArgs(argv.slice(1));
        case 'list':
        case 'ls':
            return createBaseArgs('mcp-list');
        case 'remove':
        case 'rm':
            return parseMcpRemoveArgs(argv.slice(1));
        case 'test':
            return parseMcpTestArgs(argv.slice(1));
        default:
            throw new Error(
                subcommand === undefined
                    ? 'Unsupported mcp command: missing'
                    : `Unsupported mcp command: ${subcommand}`,
            );
    }
}

function parseMcpAddArgs(argv: readonly string[]): CliArgs {
    const name = argv[0];
    if (name === undefined) {
        throw new Error('mcp add requires a server name');
    }
    let type: 'local' | 'remote' | undefined;
    const command: string[] = [];
    let url: string | undefined;
    const env: McpKeyValueArg[] = [];
    const header: McpKeyValueArg[] = [];
    let scope: McpScope = 'project';
    let enabled: boolean | undefined;
    let timeoutMs: number | undefined;
    let index = 1;

    while (index < argv.length) {
        const current = argv[index];
        switch (current) {
            case '--type':
                type = readTypeValue(readFlagValue(argv, index, '--type'));
                index += 2;
                break;
            case '--command':
                command.push(readFlagValue(argv, index, '--command'));
                index += 2;
                break;
            case '--url':
                url = readFlagValue(argv, index, '--url');
                index += 2;
                break;
            case '--env':
                env.push(parseKeyValue(readFlagValue(argv, index, '--env'), '--env'));
                index += 2;
                break;
            case '--header':
                header.push(parseKeyValue(readFlagValue(argv, index, '--header'), '--header'));
                index += 2;
                break;
            case '--scope':
                scope = readScopeValue(readFlagValue(argv, index, '--scope'));
                index += 2;
                break;
            case '--enabled':
                enabled = true;
                index += 1;
                break;
            case '--disabled':
                enabled = false;
                index += 1;
                break;
            case '--timeout':
                timeoutMs = readTimeoutValue(readFlagValue(argv, index, '--timeout'));
                index += 2;
                break;
            default:
                throw new Error(`Unsupported mcp add argument: ${current}`);
        }
    }

    if (type === undefined) {
        type = 'local';
    }

    return {
        ...createBaseArgs('mcp-add'),
        mcpName: name,
        ...(type !== undefined ? { mcpType: type } : {}),
        ...(command.length > 0 ? { mcpCommand: command } : {}),
        ...(url !== undefined ? { mcpUrl: url } : {}),
        ...(env.length > 0 ? { mcpEnv: env } : {}),
        ...(header.length > 0 ? { mcpHeader: header } : {}),
        mcpScope: scope,
        ...(enabled !== undefined ? { mcpEnabled: enabled } : {}),
        ...(timeoutMs !== undefined ? { mcpTimeoutMs: timeoutMs } : {}),
    };
}

function parseMcpRemoveArgs(argv: readonly string[]): CliArgs {
    const name = argv[0];
    if (name === undefined) {
        throw new Error('mcp remove requires a server name');
    }
    let scope: McpScope = 'project';
    let index = 1;
    while (index < argv.length) {
        const current = argv[index];
        switch (current) {
            case '--scope':
                scope = readScopeValue(readFlagValue(argv, index, '--scope'));
                index += 2;
                break;
            default:
                throw new Error(`Unsupported mcp remove argument: ${current}`);
        }
    }
    return { ...createBaseArgs('mcp-remove'), mcpName: name, mcpScope: scope };
}

function parseMcpTestArgs(argv: readonly string[]): CliArgs {
    const name = argv[0];
    if (name === undefined) {
        throw new Error('mcp test requires a server name');
    }
    if (argv[1] !== undefined) {
        throw new Error(`Unsupported mcp test argument: ${argv[1]}`);
    }
    return { ...createBaseArgs('mcp-test'), mcpName: name };
}

function createBaseArgs(command: McpCliCommand): CliArgs {
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

function readTypeValue(value: string): 'local' | 'remote' {
    if (value !== 'local' && value !== 'remote') {
        throw new Error(`--type must be local or remote (got ${value})`);
    }
    return value;
}

function readScopeValue(value: string): McpScope {
    if (value !== 'project' && value !== 'user') {
        throw new Error(`--scope must be project or user (got ${value})`);
    }
    return value;
}

function readTimeoutValue(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--timeout must be a positive integer (got ${value})`);
    }
    return parsed;
}

function parseKeyValue(value: string, flag: string): McpKeyValueArg {
    const separatorIndex = value.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        throw new Error(`${flag} requires KEY=VALUE`);
    }
    return {
        key: value.slice(0, separatorIndex),
        value: value.slice(separatorIndex + 1),
    };
}
