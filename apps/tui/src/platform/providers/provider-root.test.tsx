import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import {
    composeMissionControlProviderTree,
    createRequiredContext,
    MissingTuiProviderError,
    MissionControlTuiProviders,
    type TuiDialogService,
    type TuiKeymapProviderComponent,
    TuiProviderLifecycleScope,
    type TuiRouteService,
    type TuiThemeService,
    useTuiDialog,
    useTuiProviderLifecycle,
    useTuiRoute,
    useTuiTheme,
} from './index';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TestService = {
    readonly label: string;
};

type TestRenderer = {
    readonly id: string;
    copyToClipboardOSC52(text: string): boolean;
    isOsc52Supported(): boolean;
};

type TempProviderRoots = {
    readonly workspace: string;
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
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-providers-'));
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { recursive: true });
    return { workspace };
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

describe('TUI provider composition root', () => {
    it('throws a deterministic error when a required provider hook is used outside providers', () => {
        const serviceContext = createRequiredContext<TestService>('TestService');
        function Consumer(): JSX.Element {
            serviceContext.useValue();
            return null;
        }

        let thrown: unknown;
        try {
            runInSolidRoot(() => {
                createComponent(Consumer, {});
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(MissingTuiProviderError);
        if (thrown instanceof MissingTuiProviderError) {
            expect(thrown.providerName).toBe('TestService');
            expect(thrown.message).toBe(
                'Missing TUI provider "TestService". Mount MissionControlTuiProviders above this hook.',
            );
        }
    });

    it('renders consumers with a required provider value', () => {
        const serviceContext = createRequiredContext<TestService>('TestService');
        let observed = 'missing';

        function Consumer(): JSX.Element {
            observed = serviceContext.useValue().label;
            return null;
        }

        runInSolidRoot(() => {
            createComponent(serviceContext.Provider, {
                value: { label: 'provided' },
                get children() {
                    return createComponent(Consumer, {});
                },
            });
        });

        expect(observed).toBe('provided');
    });

    it('cleans registered provider resources on Solid root disposal', () => {
        let disposeRoot = (): void => {};
        let cleanupCalls = 0;

        function RegisterCleanup(): JSX.Element {
            useTuiProviderLifecycle().registerCleanup(() => {
                cleanupCalls += 1;
            });
            return null;
        }

        createRoot((dispose) => {
            disposeRoot = dispose;
            createComponent(TuiProviderLifecycleScope, {
                get children() {
                    return createComponent(RegisterCleanup, {});
                },
            });
        });

        expect(cleanupCalls).toBe(0);
        disposeRoot();
        disposeRoot();

        expect(cleanupCalls).toBe(1);
    });

    it('wraps children in exactly one injected keymap provider', () => {
        const roots = makeTempProviderRoots();
        const renderer: TestRenderer = {
            id: 'renderer-1',
            copyToClipboardOSC52: () => true,
            isOsc52Supported: () => true,
        };
        const events: string[] = [];
        const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => {
            events.push(`keymap:${props.useRenderer().id}`);
            return props.children;
        };

        function Child(): JSX.Element {
            events.push('child');
            return null;
        }

        runInSolidRoot(() => {
            composeMissionControlProviderTree({
                useRenderer: () => renderer,
                keymapProvider,
                runtimeOptions: makeRuntimeOptions(roots),
                get children() {
                    return createComponent(Child, {});
                },
            });
        });

        expect(events).toEqual(['keymap:renderer-1', 'child']);
    });

    it('keeps public wrapper children lazy until route, dialog, and theme providers are mounted', () => {
        const roots = makeTempProviderRoots();
        const renderer: TestRenderer = {
            id: 'renderer-1',
            copyToClipboardOSC52: () => true,
            isOsc52Supported: () => true,
        };
        const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
        let services:
            | {
                  readonly route: TuiRouteService;
                  readonly dialog: TuiDialogService;
                  readonly theme: TuiThemeService;
              }
            | undefined;
        let disposeRoot = (): void => {};

        function Child(): JSX.Element {
            services = { route: useTuiRoute(), dialog: useTuiDialog(), theme: useTuiTheme() };
            return null;
        }

        createRoot((dispose) => {
            disposeRoot = dispose;
            createComponent(MissionControlTuiProviders, {
                useRenderer: () => renderer,
                keymapProvider,
                runtimeOptions: makeRuntimeOptions(roots),
                get children() {
                    return createComponent(Child, {});
                },
            });
        });

        if (services === undefined) {
            throw new Error('public provider services did not render');
        }
        services.route.setRoute({ id: 'plugin:public-wrapper', label: 'Public Wrapper', kind: 'plugin' });
        const closeDialog = services.dialog.open({ title: 'Wrapper Dialog', body: 'ready' });

        expect(services.route.current().id).toBe('plugin:public-wrapper');
        expect(services.theme.overlayTheme().accents.question).toBe('#ff00ff');
        expect(services.dialog.current()?.title).toBe('Wrapper Dialog');

        closeDialog();
        disposeRoot();
    });
});
