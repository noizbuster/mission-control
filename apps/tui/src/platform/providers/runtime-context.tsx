/** @jsxImportSource @opentui/solid */

import { resolveMissionControlDataDir, resolveUserConfigDir } from '@mission-control/core';
import type { JSX } from 'solid-js';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types.js';
import { type ResolveKeybindConfigResult, resolveKeybindConfig } from '../keymap/keybind-config-loader.js';
import { createRequiredContext } from './context-base.js';

export type TuiColorMode = 'auto' | 'forced' | 'disabled';

export type TuiRuntimeProviderValue = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly workspaceRoot?: string;
    readonly gitBranch?: string;
    readonly isWorktree: boolean;
};

export type TuiPathsProviderValue = {
    readonly dataDir: string;
    readonly configDir: string;
    readonly workspaceRoot: string;
};

export type TuiArgsProviderValue = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
};

export type TuiTerminalEnvironmentProviderValue = {
    readonly stdinIsTty: boolean;
    readonly stdoutIsTty: boolean;
    readonly stderrIsTty: boolean;
    readonly term: string | undefined;
    readonly colorMode: TuiColorMode;
};

export type TuiStartupProviderValue = {
    readonly startedAtEpochMs: number;
    readonly initialProviderID: string;
    readonly initialModelID: string;
    readonly initialSessionID?: string;
};

export type TuiConfigProviderValue = {
    readonly keybinds: ResolveKeybindConfigResult['keybinds'];
    readonly keybindDiagnostics: ResolveKeybindConfigResult['diagnostics'];
    readonly keybindSourcePath: ResolveKeybindConfigResult['sourcePath'];
};

export type MissionControlTuiProviderEnvironment = {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly now?: () => number;
    readonly terminal?: {
        readonly stdinIsTty?: boolean;
        readonly stdoutIsTty?: boolean;
        readonly stderrIsTty?: boolean;
    };
};

export type MissionControlRuntimeProvidersProps = {
    readonly runtimeOptions: ChatTuiRuntimeOptions;
    readonly environment?: MissionControlTuiProviderEnvironment;
    readonly children: JSX.Element;
};

const TuiRuntimeContext = createRequiredContext<TuiRuntimeProviderValue>('TuiRuntime');
const TuiPathsContext = createRequiredContext<TuiPathsProviderValue>('TuiPaths');
const TuiArgsContext = createRequiredContext<TuiArgsProviderValue>('TuiArgs');
const TuiTerminalEnvironmentContext =
    createRequiredContext<TuiTerminalEnvironmentProviderValue>('TuiTerminalEnvironment');
const TuiStartupContext = createRequiredContext<TuiStartupProviderValue>('TuiStartup');
const TuiConfigContext = createRequiredContext<TuiConfigProviderValue>('TuiConfig');
const noColorEnvKey = 'NO_COLOR';
const forceColorEnvKey = 'FORCE_COLOR';
const termEnvKey = 'TERM';

export function useTuiRuntime(): TuiRuntimeProviderValue {
    return TuiRuntimeContext.useValue();
}

export function useTuiPaths(): TuiPathsProviderValue {
    return TuiPathsContext.useValue();
}

export function useTuiArgs(): TuiArgsProviderValue {
    return TuiArgsContext.useValue();
}

export function useTuiTerminalEnvironment(): TuiTerminalEnvironmentProviderValue {
    return TuiTerminalEnvironmentContext.useValue();
}

export function useTuiStartup(): TuiStartupProviderValue {
    return TuiStartupContext.useValue();
}

export function useTuiConfig(): TuiConfigProviderValue {
    return TuiConfigContext.useValue();
}

export function MissionControlRuntimeProviders(props: MissionControlRuntimeProvidersProps): JSX.Element {
    const env = props.environment?.env ?? process.env;
    const paths = createTuiPathsProviderValue(props.runtimeOptions, env);
    const runtime = createTuiRuntimeProviderValue(props.runtimeOptions);
    const args = createTuiArgsProviderValue(props.runtimeOptions);
    const terminal = createTuiTerminalEnvironmentProviderValue(env, props.environment);
    const startup = createTuiStartupProviderValue(props.runtimeOptions, props.environment);
    const config = createTuiConfigProviderValue(paths, env);

    return (
        <TuiRuntimeContext.Provider value={runtime}>
            <TuiPathsContext.Provider value={paths}>
                <TuiArgsContext.Provider value={args}>
                    <TuiTerminalEnvironmentContext.Provider value={terminal}>
                        <TuiStartupContext.Provider value={startup}>
                            <TuiConfigContext.Provider value={config}>{props.children}</TuiConfigContext.Provider>
                        </TuiStartupContext.Provider>
                    </TuiTerminalEnvironmentContext.Provider>
                </TuiArgsContext.Provider>
            </TuiPathsContext.Provider>
        </TuiRuntimeContext.Provider>
    );
}

function createTuiRuntimeProviderValue(options: ChatTuiRuntimeOptions): TuiRuntimeProviderValue {
    return Object.freeze({
        providerID: options.providerID,
        modelID: options.modelID,
        ...(options.variantID !== undefined ? { variantID: options.variantID } : {}),
        ...(options.sessionID !== undefined ? { sessionID: options.sessionID } : {}),
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.gitBranch !== undefined ? { gitBranch: options.gitBranch } : {}),
        isWorktree: options.isWorktree === true,
    });
}

function createTuiPathsProviderValue(
    options: ChatTuiRuntimeOptions,
    env: Readonly<Record<string, string | undefined>>,
): TuiPathsProviderValue {
    return Object.freeze({
        dataDir: resolveMissionControlDataDir({ env }),
        configDir: resolveUserConfigDir({ env }),
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
    });
}

function createTuiArgsProviderValue(options: ChatTuiRuntimeOptions): TuiArgsProviderValue {
    return Object.freeze({
        providerID: options.providerID,
        modelID: options.modelID,
        ...(options.variantID !== undefined ? { variantID: options.variantID } : {}),
        ...(options.sessionID !== undefined ? { sessionID: options.sessionID } : {}),
    });
}

function createTuiTerminalEnvironmentProviderValue(
    env: Readonly<Record<string, string | undefined>>,
    environment: MissionControlTuiProviderEnvironment | undefined,
): TuiTerminalEnvironmentProviderValue {
    return Object.freeze({
        stdinIsTty: environment?.terminal?.stdinIsTty ?? process.stdin.isTTY === true,
        stdoutIsTty: environment?.terminal?.stdoutIsTty ?? process.stdout.isTTY === true,
        stderrIsTty: environment?.terminal?.stderrIsTty ?? process.stderr.isTTY === true,
        term: env[termEnvKey],
        colorMode: resolveColorMode(env),
    });
}

function createTuiStartupProviderValue(
    options: ChatTuiRuntimeOptions,
    environment: MissionControlTuiProviderEnvironment | undefined,
): TuiStartupProviderValue {
    return Object.freeze({
        startedAtEpochMs: environment?.now?.() ?? Date.now(),
        initialProviderID: options.providerID,
        initialModelID: options.modelID,
        ...(options.sessionID !== undefined ? { initialSessionID: options.sessionID } : {}),
    });
}

function createTuiConfigProviderValue(
    paths: TuiPathsProviderValue,
    env: Readonly<Record<string, string | undefined>>,
): TuiConfigProviderValue {
    const keybindConfig = resolveKeybindConfig({
        workspaceRoot: paths.workspaceRoot,
        userConfigDir: paths.configDir,
        env,
    });
    return Object.freeze({
        keybinds: keybindConfig.keybinds,
        keybindDiagnostics: keybindConfig.diagnostics,
        keybindSourcePath: keybindConfig.sourcePath,
    });
}

function resolveColorMode(env: Readonly<Record<string, string | undefined>>): TuiColorMode {
    const noColor = env[noColorEnvKey];
    if (noColor !== undefined && noColor.length > 0) {
        return 'disabled';
    }
    const forceColor = env[forceColorEnvKey];
    if (forceColor !== undefined && forceColor.length > 0 && forceColor !== '0') {
        return 'forced';
    }
    return 'auto';
}
