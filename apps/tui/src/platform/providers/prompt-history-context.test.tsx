import { TuiStores } from '@mission-control/core';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { type ChatStore, createChatStore } from '../../state/chat-store.js';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types.js';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiKeymapProviderComponent,
    useTuiPromptHistory,
} from './index.js';
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

type ObservedPromptHistoryProviderValues = {
    readonly promptHistory: ReturnType<typeof useTuiPromptHistory>;
};

type RenderedPromptHistoryProviderValues = ObservedPromptHistoryProviderValues & {
    readonly roots: TempProviderRoots;
    readonly chatStore: ChatStore;
    readonly dispose: () => void;
};

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-history-provider-'));
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
        sessionID: 'history-session',
        workspaceRoot: roots.workspace,
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

function renderPromptHistoryProviderValues(roots = makeTempProviderRoots()): RenderedPromptHistoryProviderValues {
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    const chatStore = createChatStore();
    let observed: ObservedPromptHistoryProviderValues | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            promptHistory: useTuiPromptHistory(),
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
            chatStore,
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('prompt history provider consumer did not render');
    }
    return { ...observed, roots, chatStore, dispose: disposeRoot };
}

function promptHistoryStore(roots: TempProviderRoots): TuiStores.TuiPromptHistoryStore {
    return new TuiStores.TuiPromptHistoryStore({
        dataDir: roots.dataDir,
        now: () => 10,
        idFactory: () => 'entry-id',
    });
}

describe('TUI prompt history provider', () => {
    it('hydrates ChatStore history entries from the typed prompt history store', async () => {
        const roots = makeTempProviderRoots();
        await promptHistoryStore(roots).replaceEntries([
            { id: 'old', text: 'old prompt', timestamp: 1 },
            { id: 'new', text: 'new prompt', timestamp: 2 },
        ]);

        const rendered = renderPromptHistoryProviderValues(roots);
        await rendered.promptHistory.ready;

        expect(rendered.promptHistory.texts()).toEqual(['old prompt', 'new prompt']);
        expect(rendered.chatStore.getSnapshot().historyEntries).toEqual([
            { id: 'old', text: 'old prompt', timestamp: 1 },
            { id: 'new', text: 'new prompt', timestamp: 2 },
        ]);
        rendered.chatStore.openHistoryPicker('');
        expect(rendered.chatStore.confirmHistoryPicker()).toBe('new prompt');

        rendered.dispose();
    });

    it('does not persist automatically when ChatStore submits because the CLI/core bridge is the writer', async () => {
        const rendered = renderPromptHistoryProviderValues();
        await rendered.promptHistory.ready;

        rendered.chatStore.submitLine('single source');
        await flushSolidMount();

        await expect(promptHistoryStore(rendered.roots).listTexts()).resolves.toEqual([]);
        expect(rendered.promptHistory.texts()).toEqual([]);

        rendered.dispose();
    });

    it('appendPrompt persists once and realigns in-memory recall without duplicating a submitted prompt', async () => {
        const rendered = renderPromptHistoryProviderValues();
        await rendered.promptHistory.ready;

        rendered.chatStore.submitLine('dedupe me');
        await rendered.promptHistory.appendPrompt('dedupe me');
        await rendered.promptHistory.appendPrompt('dedupe me');

        await expect(promptHistoryStore(rendered.roots).listTexts()).resolves.toEqual(['dedupe me']);
        expect(rendered.promptHistory.texts()).toEqual(['dedupe me']);
        expect(rendered.chatStore.getSnapshot().historyEntries.map((entry) => entry.text)).toEqual(['dedupe me']);

        rendered.dispose();
    });
});
