import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import { clearKeybindConfigCache, KEYBIND_CONFIG_FILENAME } from '../keymap/keybind-config-loader';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiKeymapProviderComponent,
    useTuiArgs,
    useTuiConfig,
    useTuiPaths,
    useTuiRuntime,
    useTuiStartup,
    useTuiTerminalEnvironment,
} from './index';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TestRenderer = {
    readonly id: string;
    copyToClipboardOSC52(text: string): boolean;
    isOsc52Supported(): boolean;
};

type TempProviderRoots = {
    readonly workspace: string;
    readonly dataDir: string;
    readonly configDir: string;
};

type ObservedProviderValues = {
    readonly runtime: ReturnType<typeof useTuiRuntime>;
    readonly paths: ReturnType<typeof useTuiPaths>;
    readonly args: ReturnType<typeof useTuiArgs>;
    readonly terminal: ReturnType<typeof useTuiTerminalEnvironment>;
    readonly startup: ReturnType<typeof useTuiStartup>;
    readonly config: ReturnType<typeof useTuiConfig>;
};

function runInSolidRoot(work: () => void): void {
    createRoot((dispose) => {
        try {
            work();
        } finally {
            dispose();
        }
    });
}

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-runtime-providers-'));
    const workspace = join(base, 'workspace');
    const dataDir = join(base, 'data');
    const configDir = join(base, 'config');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    return { workspace, dataDir, configDir };
}

function makeRuntimeOptions(roots: TempProviderRoots): ChatTuiRuntimeOptions {
    return {
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variantID: 'reasoning-high',
        sessionID: 'session-1',
        workspaceRoot: roots.workspace,
        gitBranch: 'feature/providers',
        isWorktree: true,
    };
}

function makeProviderEnvironment(roots: TempProviderRoots): MissionControlTuiProviderEnvironment {
    return {
        env: {
            MCTRL_DATA_DIR: roots.dataDir,
            MCTRL_CONFIG_DIR: roots.configDir,
            FORCE_COLOR: '1',
            TERM: 'xterm-256color',
        },
        now: () => 1234,
        terminal: {
            stdinIsTty: true,
            stdoutIsTty: true,
            stderrIsTty: false,
        },
    };
}

function requireObserved(value: ObservedProviderValues | undefined): ObservedProviderValues {
    if (value === undefined) {
        throw new Error('provider consumer did not render');
    }
    return value;
}

function renderProviderConsumer(roots: TempProviderRoots): ObservedProviderValues {
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    let observed: ObservedProviderValues | undefined;

    function Consumer(): JSX.Element {
        observed = {
            runtime: useTuiRuntime(),
            paths: useTuiPaths(),
            args: useTuiArgs(),
            terminal: useTuiTerminalEnvironment(),
            startup: useTuiStartup(),
            config: useTuiConfig(),
        };
        return null;
    }

    runInSolidRoot(() => {
        composeMissionControlProviderTree({
            useRenderer: () => renderer,
            keymapProvider,
            runtimeOptions: makeRuntimeOptions(roots),
            environment: makeProviderEnvironment(roots),
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    return requireObserved(observed);
}

describe('TUI runtime/path/config providers', () => {
    it('provides frozen runtime, args, terminal, startup, and path values from runtime options and env', () => {
        clearKeybindConfigCache();
        const roots = makeTempProviderRoots();

        const values = renderProviderConsumer(roots);

        expect(values.runtime).toMatchObject({
            providerID: 'openai',
            modelID: 'gpt-5.5',
            variantID: 'reasoning-high',
            sessionID: 'session-1',
            workspaceRoot: roots.workspace,
            gitBranch: 'feature/providers',
            isWorktree: true,
        });
        expect(values.paths).toMatchObject({
            dataDir: roots.dataDir,
            configDir: roots.configDir,
            workspaceRoot: roots.workspace,
        });
        expect(values.args).toMatchObject({ providerID: 'openai', modelID: 'gpt-5.5', variantID: 'reasoning-high' });
        expect(values.terminal).toMatchObject({
            stdinIsTty: true,
            stdoutIsTty: true,
            stderrIsTty: false,
            term: 'xterm-256color',
            colorMode: 'forced',
        });
        expect(values.startup).toMatchObject({ startedAtEpochMs: 1234, initialProviderID: 'openai' });
        expect(values.config.keybinds.model_cycle).toBe('ctrl+p');
        expect(values.config.keybindSourcePath).toBeNull();
        expect([
            Object.isFrozen(values.runtime),
            Object.isFrozen(values.paths),
            Object.isFrozen(values.args),
            Object.isFrozen(values.terminal),
            Object.isFrozen(values.startup),
            Object.isFrozen(values.config),
        ]).toEqual([true, true, true, true, true, true]);
        clearKeybindConfigCache();
    });

    it('keeps TUI config discovery in the config dir and separate from the data dir', () => {
        clearKeybindConfigCache();
        const roots = makeTempProviderRoots();
        writeFileSync(join(roots.configDir, KEYBIND_CONFIG_FILENAME), '{"model_cycle":"f8"}', 'utf8');
        writeFileSync(join(roots.dataDir, KEYBIND_CONFIG_FILENAME), '{"model_cycle":"f1"}', 'utf8');

        const values = renderProviderConsumer(roots);

        expect(values.paths.dataDir).toBe(roots.dataDir);
        expect(values.paths.configDir).toBe(roots.configDir);
        expect(values.config.keybinds.model_cycle).toBe('f8');
        expect(values.config.keybindSourcePath).toBe(join(roots.configDir, KEYBIND_CONFIG_FILENAME));
        expect(values.config.keybindSourcePath).not.toContain(roots.dataDir);
        clearKeybindConfigCache();
    });
});
