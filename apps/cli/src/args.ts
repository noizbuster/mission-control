import type { ModelProviderSelection } from '@mission-control/protocol';
import { parseAuthArgs } from './auth-args.js';
import { type McpKeyValueArg, type McpScope, parseMcpArgs } from './mcp-args.js';
import { parseGraphArgs, parseRunArgs } from './run-args.js';
import { parseSessionArgs } from './session-args.js';

export type CliMode = 'ink' | 'plain' | 'json' | 'jsonl';

export type CliCommand =
    | 'run'
    | 'auth-login'
    | 'auth-list'
    | 'auth-logout'
    | 'models'
    | 'session-list'
    | 'session-show'
    | 'session-replay'
    | 'session-export'
    | 'session-import'
    | 'mcp-add'
    | 'mcp-list'
    | 'mcp-remove'
    | 'mcp-test';

export type AuthCredentialArg = {
    readonly fieldID: string;
    readonly value: string;
};

export type CliArgs = {
    readonly mode: CliMode;
    readonly useNative: boolean | undefined;
    readonly command: CliCommand;
    readonly showHelp: boolean;
    readonly showVersion: boolean;
    readonly graphPath?: string;
    readonly prompt?: string;
    /**
     * Workflow name resolved from the `--workflow <name>` flag. When set, the prompt is the
     * remaining positional argument. Mutually exclusive with `graphPath`.
     */
    readonly workflowName?: string;
    readonly sessionId?: string;
    /**
     * Explicit target workspace path passed via `--workspace <path>`. When unset, the runtime
     * falls back to `MCTRL_WORKSPACE` env var and then to the `detectWorkspaceRoot()` heuristic.
     */
    readonly workspacePath?: string;
    /**
     * Execution engine for prompt runs. `'graph'` (the only supported value) routes through the
     * ABG coding-agent graph + the AI-SDK `resolveSdkModel` bridge. Retained as an explicit flag
     * for callers/tests that pass `--engine graph`; the value `'flat'` is no longer accepted.
     */
    readonly engine?: 'graph';
    readonly filePath?: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly authProviderID?: string;
    readonly authModelID?: string;
    readonly authMethodID?: string;
    readonly authApiKey?: string;
    readonly authCredentials?: readonly AuthCredentialArg[];
    readonly modelsProviderID?: string;
    readonly mcpName?: string;
    readonly mcpType?: 'local' | 'remote';
    readonly mcpCommand?: readonly string[];
    readonly mcpUrl?: string;
    readonly mcpEnv?: readonly McpKeyValueArg[];
    readonly mcpHeader?: readonly McpKeyValueArg[];
    readonly mcpScope?: McpScope;
    readonly mcpTimeoutMs?: number;
    readonly mcpEnabled?: boolean;
    /** When true, `session replay` mounts the Ink overlay instead of dumping JSONL. */
    readonly replayInteractive?: boolean;
};

export const supportedCliFlags = [
    '--ui',
    '--no-tui',
    '--json',
    '--jsonl',
    '--native',
    '--no-native',
    '--provider',
    '--model',
    '--graph',
    '--workflow',
    '--engine',
    '--session',
    '--workspace',
    '--api-key',
    '--credential',
    '--method',
    '--version',
    '--help',
] as const;

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
    if (command === 'session') {
        return parseSessionArgs(argv.slice(1));
    }
    if (command === 'mcp') {
        return parseMcpArgs(argv.slice(1));
    }
    if (command === 'graph') {
        return parseGraphArgs(argv.slice(1));
    }
    if (command === 'run') {
        return parseRunArgs(argv.slice(1), {});
    }
    return parseRunArgs(argv, {});
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
