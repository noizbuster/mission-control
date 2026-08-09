import { TuiStores } from '@mission-control/core';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { type ChatStore, createChatStore } from '../../state/chat-store';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiKeymapProviderComponent,
    useTuiFrecency,
    useTuiPromptRef,
    useTuiPromptStash,
} from './index';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

type ObservedPromptServiceValues = {
    readonly promptStash: ReturnType<typeof useTuiPromptStash>;
    readonly frecency: ReturnType<typeof useTuiFrecency>;
    readonly promptRef: ReturnType<typeof useTuiPromptRef>;
};

type RenderedPromptServiceValues = ObservedPromptServiceValues & {
    readonly roots: TempProviderRoots;
    readonly chatStore: ChatStore;
    readonly dispose: () => void;
};

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-prompt-services-'));
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
        sessionID: 'prompt-services-session',
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

function renderPromptServices(roots = makeTempProviderRoots()): RenderedPromptServiceValues {
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    const chatStore = createChatStore({ workspaceRoot: roots.workspace });
    let observed: ObservedPromptServiceValues | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            promptStash: useTuiPromptStash(),
            frecency: useTuiFrecency(),
            promptRef: useTuiPromptRef(),
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
        throw new Error('prompt services provider consumer did not render');
    }
    return { ...observed, roots, chatStore, dispose: disposeRoot };
}

async function waitForPromptServicesReady(rendered: RenderedPromptServiceValues): Promise<void> {
    await rendered.promptStash.ready;
    await rendered.frecency.ready;
}

describe('TUI prompt services provider', () => {
    it('persists prompt stash push, pop, and remove through the typed store', async () => {
        const rendered = renderPromptServices();
        await waitForPromptServicesReady(rendered);

        await rendered.promptStash.pushDraft({ text: 'first draft', cursorOffset: 5 });
        const second = await rendered.promptStash.pushDraft({ text: 'second draft', cursorOffset: 3 });
        const popped = await rendered.promptStash.popDraft();

        expect(popped?.text).toBe('second draft');
        expect(popped?.cursorOffset).toBe(3);
        expect(rendered.promptStash.entries().map((entry) => entry.text)).toEqual(['first draft']);
        await expect(
            new TuiStores.TuiPromptStashStore({ dataDir: rendered.roots.dataDir }).listEntries(),
        ).resolves.toMatchObject([{ text: 'first draft', cursorOffset: 5 }]);

        await rendered.promptStash.removeEntry(second.id);
        expect(rendered.promptStash.entries().map((entry) => entry.text)).toEqual(['first draft']);
        const remaining = rendered.promptStash.entries()[0];
        if (remaining === undefined) {
            throw new Error('expected remaining stash entry');
        }
        await rendered.promptStash.removeEntry(remaining.id);
        await expect(
            new TuiStores.TuiPromptStashStore({ dataDir: rendered.roots.dataDir }).listEntries(),
        ).resolves.toEqual([]);

        rendered.dispose();
    });

    it('hydrates valid stash and frecency records while dropping malformed JSONL records', async () => {
        const roots = makeTempProviderRoots();
        const stashStore = new TuiStores.TuiPromptStashStore({ dataDir: roots.dataDir });
        const frecencyStore = new TuiStores.TuiFrecencyStore({ dataDir: roots.dataDir });
        mkdirSync(dirname(stashStore.filePath), { recursive: true });
        mkdirSync(dirname(frecencyStore.filePath), { recursive: true });
        writeFileSync(
            stashStore.filePath,
            `${JSON.stringify({ id: 'good-stash', text: 'safe draft', cursorOffset: 2, timestamp: 1 })}\nnot-json\n${JSON.stringify({ id: 'bad-stash' })}\n`,
            'utf8',
        );
        writeFileSync(
            frecencyStore.filePath,
            `${JSON.stringify({ key: 'zeta.ts', accessCount: 3, firstSeenAt: 1, lastAccessedAt: 10 })}\nnot-json\n${JSON.stringify({ key: 'bad', accessCount: 0, firstSeenAt: 1, lastAccessedAt: 2 })}\n`,
            'utf8',
        );

        const rendered = renderPromptServices(roots);
        await waitForPromptServicesReady(rendered);

        expect(rendered.promptStash.entries().map((entry) => entry.text)).toEqual(['safe draft']);
        expect(rendered.frecency.rankedKeys()).toEqual(['zeta.ts']);

        rendered.dispose();
    });

    it('orders file autocomplete by frecency only after records exist and PromptRef records selections', async () => {
        const roots = makeTempProviderRoots();
        writeFileSync(join(roots.workspace, 'alpha.ts'), 'alpha', 'utf8');
        writeFileSync(join(roots.workspace, 'zeta.ts'), 'zeta', 'utf8');
        const rendered = renderPromptServices(roots);
        await waitForPromptServicesReady(rendered);

        rendered.chatStore.setInputMirror('@');
        rendered.chatStore.ensureFileAutocompleteCurrent();
        expect(rendered.chatStore.getSnapshot().fileAutocomplete.matches.map((match) => match.name)).toEqual([
            'alpha.ts',
            'zeta.ts',
        ]);

        await rendered.promptRef.recordFileReference('zeta.ts');
        rendered.chatStore.setInputMirror('@');
        rendered.chatStore.ensureFileAutocompleteCurrent();

        expect(rendered.frecency.rankedKeys()[0]).toBe('zeta.ts');
        expect(rendered.chatStore.getSnapshot().fileAutocomplete.matches.map((match) => match.name)).toEqual([
            'zeta.ts',
            'alpha.ts',
        ]);

        rendered.dispose();
    });
});
