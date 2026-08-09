import { TuiStores } from '@mission-control/core';
import type { ModelProviderSelection, TuiLocalPreferences } from '@mission-control/protocol';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiKeymapProviderComponent,
    useTuiArgs,
    useTuiLocalPreferences,
} from './index';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

type ObservedLocalProviderValues = {
    readonly local: ReturnType<typeof useTuiLocalPreferences>;
    readonly args: ReturnType<typeof useTuiArgs>;
};

type RenderedLocalProviderValues = ObservedLocalProviderValues & {
    readonly roots: TempProviderRoots;
    readonly dispose: () => void;
};

function selection(providerID: string, modelID: string, variantID?: string): ModelProviderSelection {
    return { providerID, modelID, ...(variantID !== undefined ? { variantID } : {}) };
}

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-local-provider-'));
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
        sessionID: 'active-session',
        workspaceRoot: roots.workspace,
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

async function flushSolidMount(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function renderLocalProviderValues(roots = makeTempProviderRoots()): RenderedLocalProviderValues {
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    let observed: ObservedLocalProviderValues | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            local: useTuiLocalPreferences(),
            args: useTuiArgs(),
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
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('local provider consumer did not render');
    }
    return { ...observed, roots, dispose: disposeRoot };
}

async function readStoredPreferences(dataDir: string): Promise<TuiLocalPreferences> {
    return new TuiStores.TuiLocalPreferencesStore({ dataDir }).getPreferences();
}

describe('TUI local preferences provider', () => {
    it('persists local model recents, favorites, variant hints, session pins, and UI toggles under the data dir', async () => {
        const rendered = renderLocalProviderValues();
        await flushSolidMount();

        await rendered.local.addRecentModel(selection('openai', 'gpt-5.5', 'reasoning-high'));
        await rendered.local.setFavoriteModel(selection('anthropic', 'claude-sonnet-4-6'), true);
        await rendered.local.setVariantCyclingHint({ modelId: 'openai/gpt-5.5', variantId: 'reasoning-high' });
        await rendered.local.pinSession('session-quick-switch');
        await rendered.local.setUiToggle({ key: 'show-graph-minimap', value: true });

        expect(rendered.local.preferences()).toEqual({
            recentModels: ['openai/gpt-5.5#reasoning-high'],
            favoriteModels: ['anthropic/claude-sonnet-4-6'],
            variantCyclingHints: [{ modelId: 'openai/gpt-5.5', variantId: 'reasoning-high' }],
            sessionPins: ['session-quick-switch'],
            uiToggles: [{ key: 'show-graph-minimap', value: true }],
            modelContextPrefs: [],
        });
        await expect(readStoredPreferences(rendered.roots.dataDir)).resolves.toEqual(rendered.local.preferences());
        expect(new TuiStores.TuiLocalPreferencesStore({ dataDir: rendered.roots.dataDir }).filePath).toBe(
            join(rendered.roots.dataDir, 'tui', 'local-preferences.json'),
        );

        rendered.dispose();
    });

    it('keeps active session model selection and durable session id out of local preferences until explicit local actions', async () => {
        const rendered = renderLocalProviderValues();
        await flushSolidMount();

        expect(rendered.args).toMatchObject({
            providerID: 'openai',
            modelID: 'gpt-5.5',
            variantID: 'reasoning-high',
            sessionID: 'active-session',
        });
        expect(rendered.local.preferences()).toEqual(TuiStores.emptyTuiLocalPreferences());

        await rendered.local.setFavoriteModel(selection('openai', 'gpt-5.5', 'reasoning-high'), true);

        expect(rendered.local.preferences()).toMatchObject({
            favoriteModels: ['openai/gpt-5.5#reasoning-high'],
            sessionPins: [],
        });

        rendered.dispose();
    });

    it('self-heals malformed local preferences without changing auth-backed model role storage', async () => {
        const roots = makeTempProviderRoots();
        const localStore = new TuiStores.TuiLocalPreferencesStore({ dataDir: roots.dataDir });
        mkdirSync(dirname(localStore.filePath), { recursive: true });
        writeFileSync(localStore.filePath, '{bad json', 'utf8');
        const authPath = join(roots.dataDir, 'auth.json');
        const authContents = '{"modelRoles":{"slow":{"providerID":"anthropic","modelID":"claude-sonnet-4-6"}}}';
        writeFileSync(authPath, authContents, 'utf8');

        const rendered = renderLocalProviderValues(roots);
        await flushSolidMount();

        expect(rendered.local.preferences()).toEqual(TuiStores.emptyTuiLocalPreferences());
        expect(readFileSync(authPath, 'utf8')).toBe(authContents);
        expect(Object.keys(rendered.local).sort()).toEqual([
            'addRecentModel',
            'pinSession',
            'preferences',
            'reload',
            'setFavoriteModel',
            'setUiToggle',
            'setVariantCyclingHint',
            'stepModelAutoCompactThreshold',
            'stepModelContextLimit',
            'unpinSession',
        ]);

        rendered.dispose();
    });

    it('serializes concurrent context limit steps without losing updates', async () => {
        const sel = selection('openai', 'gpt-5.5');
        const catalogDefault = 128_000;

        const concurrent = renderLocalProviderValues();
        await flushSolidMount();
        const results = await Promise.all([
            concurrent.local.stepModelContextLimit(sel, 1, catalogDefault),
            concurrent.local.stepModelContextLimit(sel, 1, catalogDefault),
            concurrent.local.stepModelContextLimit(sel, 1, catalogDefault),
        ]);
        const concurrentLimit = results.at(-1)?.contextLimit;
        concurrent.dispose();

        const sequential = renderLocalProviderValues();
        await flushSolidMount();
        await sequential.local.stepModelContextLimit(sel, 1, catalogDefault);
        await sequential.local.stepModelContextLimit(sel, 1, catalogDefault);
        const expected = await sequential.local.stepModelContextLimit(sel, 1, catalogDefault);
        sequential.dispose();

        expect(concurrentLimit).toBeDefined();
        expect(concurrentLimit).toBe(expected?.contextLimit);
    });
});
