import type { ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs, CliMode } from './args.js';

type InitialRunArgs = {
    readonly graphPath?: string;
};

export function parseRunArgs(argv: readonly string[], initial: InitialRunArgs): CliArgs {
    let mode: CliMode = 'ink';
    let jsonMode: 'json' | 'jsonl' | undefined;
    let useNative: boolean | undefined;
    let showHelp = false;
    let showVersion = false;
    let providerID: string | undefined;
    let modelID: string | undefined;
    let graphPath = initial.graphPath;
    let sessionId: string | undefined;
    const promptParts: string[] = [];
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
                setJsonMode('json');
                mode = 'json';
                index += 1;
                break;
            case '--jsonl':
                setJsonMode('jsonl');
                mode = 'jsonl';
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
            case '--graph':
                graphPath = readFlagValue(argv, index, '--graph');
                index += 2;
                break;
            case '--session':
                sessionId = readFlagValue(argv, index, '--session');
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
            default:
                if (current === undefined || current.startsWith('--')) {
                    throw new Error(`Unsupported argument: ${current}`);
                }
                promptParts.push(current);
                index += 1;
        }
    }
    return buildRunArgs({
        graphPath,
        mode,
        modelID,
        prompt: promptParts.length === 0 ? undefined : promptParts.join(' '),
        providerID,
        sessionId,
        showHelp,
        showVersion,
        useNative,
    });

    function setJsonMode(nextMode: 'json' | 'jsonl'): void {
        if (jsonMode !== undefined && jsonMode !== nextMode) {
            throw new Error('--json and --jsonl cannot be combined');
        }
        jsonMode = nextMode;
    }
}

export function parseGraphArgs(argv: readonly string[]): CliArgs {
    const command = argv[0];
    if (command !== 'run') {
        throw new Error(`Unsupported graph command: ${command ?? ''}`);
    }
    const graphPath = argv[1];
    if (graphPath === undefined || graphPath.startsWith('--')) {
        throw new Error('graph run requires a graph file');
    }
    return parseRunArgs(argv.slice(2), { graphPath });
}

function buildRunArgs(input: {
    readonly graphPath: string | undefined;
    readonly mode: CliMode;
    readonly modelID: string | undefined;
    readonly prompt: string | undefined;
    readonly providerID: string | undefined;
    readonly sessionId: string | undefined;
    readonly showHelp: boolean;
    readonly showVersion: boolean;
    readonly useNative: boolean | undefined;
}): CliArgs {
    if (input.graphPath !== undefined && input.prompt !== undefined) {
        throw new Error('prompt cannot be combined with --graph');
    }
    const baseArgs = {
        mode: input.mode,
        useNative: input.useNative,
        command: 'run',
        showHelp: input.showHelp,
        showVersion: input.showVersion,
        ...(input.graphPath !== undefined ? { graphPath: input.graphPath } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    } satisfies CliArgs;
    const modelProviderSelection = resolveModelProviderSelection(input.providerID, input.modelID);
    if (modelProviderSelection === undefined) {
        return baseArgs;
    }
    return {
        ...baseArgs,
        modelProviderSelection,
    };
}

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
