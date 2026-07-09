import type { TuiThemePreference } from '@mission-control/protocol';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types.js';
import { BASE_MODE, type ModeStackApi, ModeStackContext, useModeStack } from '../keymap/mode-stack.js';
import {
    composeMissionControlProviderTree,
    type TuiDialogService,
    type TuiKeymapProviderComponent,
    type TuiRouteService,
    type TuiThemePreferenceStoreLike,
    type TuiThemeService,
    useTuiDialog,
    useTuiRoute,
    useTuiTheme,
} from './index.js';

type TestRenderer = {
    readonly id: string;
    copyToClipboardOSC52(text: string): boolean;
    isOsc52Supported(): boolean;
};

type ObservedProviderValues = {
    readonly route: TuiRouteService;
    readonly dialog: TuiDialogService;
    readonly theme: TuiThemeService;
    readonly modeStack: ModeStackApi;
};

type RenderedProviderValues = ObservedProviderValues & {
    readonly dispose: () => void;
};

class FakeThemePreferenceStore implements TuiThemePreferenceStoreLike {
    private preference: TuiThemePreference;
    readonly savedPreferences: TuiThemePreference[] = [];

    constructor(preference: TuiThemePreference) {
        this.preference = preference;
    }

    async getPreference(): Promise<TuiThemePreference> {
        return this.preference;
    }

    async savePreference(preference: TuiThemePreference): Promise<void> {
        this.preference = preference;
        this.savedPreferences.push(preference);
    }
}

const runtimeOptions: ChatTuiRuntimeOptions = {
    providerID: 'openai',
    modelID: 'gpt-5.5',
    sessionID: 'session-1',
};

function makeRenderer(): TestRenderer {
    return {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
}

function renderProviderValues(themeStore: TuiThemePreferenceStoreLike): RenderedProviderValues {
    const renderer = makeRenderer();
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
    let observed: ObservedProviderValues | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            route: useTuiRoute(),
            dialog: useTuiDialog(),
            theme: useTuiTheme(),
            modeStack: useModeStack(),
        };
        return null;
    }

    createRoot((dispose) => {
        disposeRoot = dispose;
        composeMissionControlProviderTree({
            useRenderer: () => renderer,
            keymapProvider,
            runtimeOptions,
            themePreferenceStore: themeStore,
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('provider consumer did not render');
    }
    return { ...observed, dispose: disposeRoot };
}

describe('TUI route provider', () => {
    it('tracks UI-local route labels without exposing session/runtime mutation methods', () => {
        const themeStore = new FakeThemePreferenceStore({ activeThemeId: 'default', customOverrides: [] });
        const services = renderProviderValues(themeStore);

        services.route.setRoute({ id: 'plugin:inspector', label: 'Inspector', kind: 'plugin' });

        expect(services.route.current()).toEqual({ id: 'plugin:inspector', label: 'Inspector', kind: 'plugin' });
        expect(services.route.history()).toEqual([
            { id: 'chat', label: 'Session session-1', kind: 'chat' },
            { id: 'plugin:inspector', label: 'Inspector', kind: 'plugin' },
        ]);
        expect(Object.keys(services.route).sort()).toEqual(['current', 'history', 'resetRoute', 'setRoute']);

        services.dispose();
    });
});

describe('TUI dialog provider', () => {
    it('keeps one active dialog focus owner and one dialog mode-stack entry', () => {
        const themeStore = new FakeThemePreferenceStore({ activeThemeId: 'default', customOverrides: [] });
        const services = renderProviderValues(themeStore);

        const closeFirst = services.dialog.open({ title: 'First', body: 'one' });
        const closeSecond = services.dialog.open({ title: 'Second', body: 'two' });

        expect(services.dialog.current()).toMatchObject({ title: 'Second', body: 'two' });
        expect(services.modeStack.current()).toBe('dialog');

        closeFirst();

        expect(services.dialog.current()).toMatchObject({ title: 'Second', body: 'two' });
        expect(services.modeStack.current()).toBe('dialog');

        closeSecond();

        expect(services.dialog.current()).toBeNull();
        expect(services.modeStack.current()).toBe('base');

        services.dispose();
    });

    it('closes the active dialog on Ctrl+C without sending an interrupt itself', () => {
        const themeStore = new FakeThemePreferenceStore({ activeThemeId: 'default', customOverrides: [] });
        const services = renderProviderValues(themeStore);

        services.dialog.open({ title: 'Interrupt?', body: 'Ctrl+C should remain the global sink.' });
        const result = services.dialog.cancel('ctrl-c');

        expect(result).toEqual({ kind: 'closed', source: 'ctrl-c' });
        expect(services.dialog.current()).toBeNull();
        expect(services.modeStack.current()).toBe('base');

        services.dispose();
    });
});

describe('TUI theme provider', () => {
    it('starts from the current static overlay and markdown themes', () => {
        const themeStore = new FakeThemePreferenceStore({ activeThemeId: 'default', customOverrides: [] });
        const services = renderProviderValues(themeStore);

        expect(services.theme.preference()).toEqual({ activeThemeId: 'default', customOverrides: [] });
        expect(services.theme.overlayTheme().selectedBg).toBe('#0000ff');
        expect(services.theme.overlayTheme().accents.question).toBe('#ff00ff');
        expect(services.theme.markdownTheme().heading).toStrictEqual({ bold: true, fg: '#00ffff' });

        services.dispose();
    });

    it('persists typed preferences, updates derived themes, and rejects malformed custom themes', async () => {
        const themeStore = new FakeThemePreferenceStore({ activeThemeId: 'default', customOverrides: [] });
        const services = renderProviderValues(themeStore);

        const saved = await services.theme.savePreference({
            activeThemeId: 'no-color',
            customOverrides: [{ key: 'overlay.accent.question', value: '#123456' }],
        });
        const malformed = await services.theme.savePreferenceFromUnknown({
            activeThemeId: 'default',
            customOverrides: [{ key: 'overlay.accent.question' }],
        });

        expect(saved).toEqual({ kind: 'saved' });
        expect(services.theme.preference().activeThemeId).toBe('no-color');
        expect(services.theme.overlayTheme().accents.question).toBe('#123456');
        expect(services.theme.markdownTheme().heading).toStrictEqual({ bold: true });
        expect(malformed).toEqual({ kind: 'invalid-preference' });
        expect(themeStore.savedPreferences).toHaveLength(1);

        services.dispose();
    });
});
