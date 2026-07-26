import type { ModelProviderSelection, SessionStopScope } from '@mission-control/protocol';
import { parseAuthArgs } from './auth-args';
import { type McpKeyValueArg, type McpScope, parseMcpArgs } from './mcp-args';
import { parseGraphArgs, parseRunArgs } from './run-args';
import { parseSessionArgs } from './session-args';

export type CliMode = 'tui' | 'plain' | 'json' | 'jsonl';

export type CliCommand =
    | 'run'
    | 'auth-login'
    | 'auth-list'
    | 'auth-logout'
    | 'models'
    | 'session-list'
    | 'session-status'
    | 'session-show'
    | 'session-replay'
    | 'session-export'
    | 'session-import'
    | 'session-delete'
    | 'session-stop'
    | 'mcp-add'
    | 'mcp-list'
    | 'mcp-remove'
    | 'mcp-test'
    | 'agents';

export type AuthCredentialArg = {
    readonly fieldID: string;
    readonly value: string;
};

export type CliArgs = {
    readonly mode: CliMode;
    readonly useNative: boolean | undefined;
    readonly command: CliCommand;
    readonly showHelp: boolean;
    readonly helpText?: string;
    readonly showVersion: boolean;
    /**
     * When true, non-interactive Plain/Tui renderers emit reasoning/thinking blocks (dimmed italic).
     * Default false (reasoning suppressed). JsonRenderer and the interactive opentui TUI ignore this
     * flag (the interactive TUI has its own Ctrl+T thinking toggle). Mirrors opencode `--thinking`.
     */
    readonly thinking: boolean;
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
     * Config profile name resolved from the long-only `--profile <name>` flag. When set, the
     * runtime loads the profile-specific global config file instead of the base `config.json`.
     * The auth `-p` provider shorthand is unrelated and never aliases this flag.
     */
    readonly profileName?: string;
    /**
     * Execution engine for prompt runs. `'graph'` (the only supported value) routes through the
     * ABG coding-agent graph + the AI-SDK `resolveSdkModel` bridge. Retained as an explicit flag
     * for callers/tests that pass `--engine graph`; the value `'flat'` is no longer accepted.
     */
    readonly engine?: 'graph';
    readonly filePath?: string;
    readonly expectedTreeToken?: string;
    readonly sessionStopScope?: SessionStopScope;
    readonly sessionStopTimeoutMs?: number;
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
    /** When true, `session replay` mounts the opentui TUI overlay instead of dumping JSONL. */
    readonly replayInteractive?: boolean;
    /** Raw argv tail forwarded to `parseAgentsSubcommand` by the `mctrl agents` command. */
    readonly agentsArgv?: readonly string[];
};

export const supportedCliFlags = [
    '--no-tui',
    '--json',
    '--jsonl',
    '--native',
    '--no-native',
    '--thinking',
    '--provider',
    '--model',
    '--graph',
    '--workflow',
    '--engine',
    '--session',
    '--workspace',
    '--profile',
    '--api-key',
    '--credential',
    '--method',
    '--version',
    '--help',
] as const;

// Charset excludes `.`, `/`, `\`, and uppercase on purpose: path-like values and traversal
// attempts (`../bad`, `.`/`..`, leading-dot, `a/b`) must fail validation, not just be unused.
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate a raw `--profile` value. `undefined` in -> `undefined` out (so callers spread the
 * result under `exactOptionalPropertyTypes`); invalid values throw naming the offending value.
 * Core re-implements the same pattern one-way rather than importing this (cli depends on core).
 */
export function parseProfileName(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!PROFILE_NAME_PATTERN.test(raw)) {
        throw new Error(
            `Invalid --profile value: ${JSON.stringify(raw)}. ` +
                'Profile names must start with a lowercase letter or digit and may contain only ' +
                "lowercase letters, digits, '_', or '-' (max 64 characters).",
        );
    }
    return raw;
}

export function createBaseArgs(command: CliCommand): Omit<CliArgs, 'modelProviderSelection'> {
    return {
        mode: 'tui',
        useNative: undefined,
        command,
        showHelp: false,
        showVersion: false,
        thinking: false,
    };
}

/**
 * Read the value following a value-taking flag (e.g. `--model x` -> `x`). Throws if the next
 * token is missing or looks like another flag. Shared by the per-command arg parsers.
 */
export function readFlagValue(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

export function parseArgs(argv: readonly string[]): CliArgs {
    // `pnpm dev:cli -- --no-tui` and `node dist/index.js -- --no-tui` forward a leading `--`
    // separator into argv. Strip it so command dispatch and flag parsing work as documented.
    // A mid-stream `--` is handled as POSIX end-of-options inside parseRunArgs.
    const args = argv[0] === '--' ? argv.slice(1) : argv;
    const command = args[0];
    if (command === 'auth') {
        return parseAuthArgs(args.slice(1));
    }
    if (command === 'models') {
        return parseModelsArgs(args.slice(1));
    }
    if (command === 'session') {
        return parseSessionArgs(args.slice(1));
    }
    if (command === 'mcp') {
        return parseMcpArgs(args.slice(1));
    }
    if (command === 'agents') {
        return { ...createBaseArgs('agents'), agentsArgv: args.slice(1) };
    }
    if (command === 'graph') {
        return parseGraphArgs(args.slice(1));
    }
    if (command === 'run') {
        return parseRunArgs(args.slice(1), {});
    }
    return parseRunArgs(args, {});
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
