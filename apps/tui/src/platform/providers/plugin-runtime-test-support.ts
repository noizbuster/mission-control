import { TuiStores } from '@mission-control/core';
import type { TuiPluginCapabilityId, TuiPluginManifestInput } from '@mission-control/protocol';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import { BASE_MODE, type ModeStackApi, ModeStackContext } from '../keymap/mode-stack';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiDialogService,
    type TuiKeymapProviderComponent,
    type TuiPluginRuntimeService,
    type TuiRouteService,
    type TuiThemeService,
    type TuiToastService,
    useTuiDialog,
    useTuiPluginRuntime,
    useTuiRoute,
    useTuiTheme,
    useTuiToast,
} from './index';
import { mkdirSync, mkdtempSync } from 'node:fs';
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

type ObservedPluginProviderValues = {
    readonly pluginRuntime: TuiPluginRuntimeService;
    readonly route: TuiRouteService;
    readonly dialog: TuiDialogService;
    readonly theme: TuiThemeService;
    readonly toast: TuiToastService;
};

export type RenderedPluginProviderValues = ObservedPluginProviderValues & {
    readonly roots: TempProviderRoots;
    readonly dispose: () => void;
};

export const allPluginCapabilities: readonly TuiPluginCapabilityId[] = [
    'ui.slot',
    'ui.route',
    'ui.command',
    'ui.dialog',
    'ui.theme',
    'ui.kv',
    'keymap.register',
    'runtime.events.read',
];

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-plugin-provider-'));
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
        sessionID: 'plugin-session',
        workspaceRoot: roots.workspace,
        gitBranch: 'feature/plugins',
        isWorktree: true,
    };
}

function makeProviderEnvironment(roots: TempProviderRoots): MissionControlTuiProviderEnvironment {
    return {
        env: {
            MCTRL_DATA_DIR: roots.dataDir,
            MCTRL_CONFIG_DIR: roots.configDir,
        },
        now: () => 1234,
    };
}

export function demoManifest(capabilities: readonly TuiPluginCapabilityId[]): TuiPluginManifestInput {
    return {
        name: 'demo-plugin',
        version: '1.0.0',
        capabilities,
        slots: [{ id: 'manifest-slot', slot: 'status.right', label: 'Manifest Slot', componentRef: 'demo.status' }],
        routes: [{ id: 'manifest-route', path: '/plugins/demo', label: 'Manifest Route' }],
        commands: [{ id: 'demo.manifest', title: 'Manifest Command' }],
    };
}

export function renderPluginProviderValues(input: {
    readonly roots?: TempProviderRoots;
    readonly allowedCapabilities: readonly TuiPluginCapabilityId[];
    readonly plugins: Parameters<typeof composeMissionControlProviderTree>[0]['plugins'];
}): RenderedPluginProviderValues {
    const roots = input.roots ?? makeTempProviderRoots();
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    let activeMode = BASE_MODE;
    const modeStackApi: ModeStackApi = {
        current: () => activeMode,
        push: (mode) => {
            activeMode = mode;
        },
        pop: () => {
            activeMode = BASE_MODE;
        },
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) =>
        createComponent(ModeStackContext.Provider, {
            value: modeStackApi,
            get children() {
                return props.children;
            },
        });
    let observed: ObservedPluginProviderValues | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            pluginRuntime: useTuiPluginRuntime(),
            route: useTuiRoute(),
            dialog: useTuiDialog(),
            theme: useTuiTheme(),
            toast: useTuiToast(),
        };
        return null;
    }

    createRoot((dispose) => {
        disposeRoot = dispose;
        composeMissionControlProviderTree({
            useRenderer: () => renderer,
            keymapProvider,
            runtimeOptions: makeRuntimeOptions(roots),
            environment: makeProviderEnvironment(roots),
            pluginManifestStore: new TuiStores.TuiPluginManifestStore({ dataDir: roots.dataDir }),
            pluginKvStore: new TuiStores.TuiKvStore({ dataDir: roots.dataDir }),
            allowedPluginCapabilities: input.allowedCapabilities,
            ...(input.plugins !== undefined ? { plugins: input.plugins } : {}),
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('plugin provider consumer did not render');
    }
    return { ...observed, roots, dispose: disposeRoot };
}
