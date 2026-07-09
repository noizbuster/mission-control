import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { createAbgOverlayController } from '../../state/abg-overlay-controller.js';
import { createAbgOverlayStore } from '../../state/abg-overlay-state.js';
import type { ChatAppActions } from '../../state/chat-app-actions.js';
import { createChatStore } from '../../state/chat-store.js';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types.js';
import type { MissionControlServicesLike } from '../../state/mission-services-types.js';
import type { WelcomeData } from '../../state/welcome-data-types.js';
import {
    composeMissionControlProviderTree,
    MissingTuiProviderError,
    type TuiKeymapProviderComponent,
    useAbgOverlayController,
    useChatAppActions,
    useChatSession,
    useMissionControlServices,
    useWelcomeData,
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
};

type ObservedChatSession = {
    readonly session: ReturnType<typeof useChatSession>;
    readonly actions: ReturnType<typeof useChatAppActions>;
    readonly abg: ReturnType<typeof useAbgOverlayController>;
    readonly welcome: ReturnType<typeof useWelcomeData>;
    readonly services: ReturnType<typeof useMissionControlServices>;
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
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-chat-session-'));
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { recursive: true });
    return { workspace };
}

function makeWelcomeData(): WelcomeData {
    return {
        version: '0.0.0-test',
        defaultModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        mcpServers: [],
        projectSkills: [],
        lspServers: [],
        recentSessions: [],
    };
}

function makeAbgController() {
    return createAbgOverlayController(createAbgOverlayStore());
}

function makeServices(): MissionControlServicesLike {
    return {
        getOmoRoot: () => '/tmp/omo',
        getJobManager: () => {
            throw new Error('not used');
        },
        getRuntimeRegistry: () => {
            throw new Error('not used');
        },
    };
}

function makeActions(): ChatAppActions {
    return {
        isValidModelPattern: (raw) => raw.includes('/'),
    };
}

function makeRuntimeOptions(
    roots: TempProviderRoots,
    extras: Partial<ChatTuiRuntimeOptions> = {},
): ChatTuiRuntimeOptions {
    return {
        providerID: 'openai',
        modelID: 'gpt-5.5',
        sessionID: 'session-chat',
        workspaceRoot: roots.workspace,
        gitBranch: 'feature/chat-session',
        isWorktree: false,
        ...extras,
    };
}

function requireObserved(value: ObservedChatSession | undefined): ObservedChatSession {
    if (value === undefined) {
        throw new Error('chat-session consumer did not render');
    }
    return value;
}

describe('TUI chat-session provider', () => {
    it('throws a deterministic error when useChatSession is used outside providers', () => {
        function Consumer(): JSX.Element {
            useChatSession();
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
            expect(thrown.providerName).toBe('TuiChatSession');
            expect(thrown.message).toBe(
                'Missing TUI provider "TuiChatSession". Mount MissionControlTuiProviders above this hook.',
            );
        }
    });

    it('materializes store and optional fields from runtimeOptions + chatStore', () => {
        const roots = makeTempProviderRoots();
        const chatStore = createChatStore();
        const welcomeData = makeWelcomeData();
        const abgOverlayController = makeAbgController();
        const missionControlServices = makeServices();
        const actions = makeActions();
        const renderer: TestRenderer = {
            id: 'renderer',
            copyToClipboardOSC52: () => true,
            isOsc52Supported: () => true,
        };
        const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
        let observed: ObservedChatSession | undefined;

        function Consumer(): JSX.Element {
            observed = {
                session: useChatSession(),
                actions: useChatAppActions(),
                abg: useAbgOverlayController(),
                welcome: useWelcomeData(),
                services: useMissionControlServices(),
            };
            return null;
        }

        runInSolidRoot(() => {
            composeMissionControlProviderTree({
                useRenderer: () => renderer,
                keymapProvider,
                runtimeOptions: makeRuntimeOptions(roots, {
                    welcomeData,
                    abgOverlayController,
                    missionControlServices,
                    actions,
                }),
                chatStore,
                get children() {
                    return createComponent(Consumer, {});
                },
            });
        });

        const values = requireObserved(observed);
        expect(values.session.store).toBe(chatStore);
        expect(values.session.welcomeData).toBe(welcomeData);
        expect(values.session.abgOverlayController).toBe(abgOverlayController);
        expect(values.session.missionControlServices).toBe(missionControlServices);
        expect(values.session.actions).toBe(actions);
        expect(values.actions).toBe(actions);
        expect(values.abg).toBe(abgOverlayController);
        expect(values.welcome).toBe(welcomeData);
        expect(values.services).toBe(missionControlServices);
        expect(Object.isFrozen(values.session)).toBe(true);
    });

    it('omits optional fields when runtimeOptions does not carry them', () => {
        const roots = makeTempProviderRoots();
        const chatStore = createChatStore();
        const renderer: TestRenderer = {
            id: 'renderer',
            copyToClipboardOSC52: () => true,
            isOsc52Supported: () => true,
        };
        const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
        let session: ReturnType<typeof useChatSession> | undefined;

        function Consumer(): JSX.Element {
            session = useChatSession();
            return null;
        }

        runInSolidRoot(() => {
            composeMissionControlProviderTree({
                useRenderer: () => renderer,
                keymapProvider,
                runtimeOptions: makeRuntimeOptions(roots),
                chatStore,
                get children() {
                    return createComponent(Consumer, {});
                },
            });
        });

        if (session === undefined) {
            throw new Error('chat-session consumer did not render');
        }
        expect(session.store).toBe(chatStore);
        expect(session.welcomeData).toBeUndefined();
        expect(session.abgOverlayController).toBeUndefined();
        expect(session.missionControlServices).toBeUndefined();
        expect(session.actions).toBeUndefined();
        expect('welcomeData' in session).toBe(false);
        expect('abgOverlayController' in session).toBe(false);
        expect('missionControlServices' in session).toBe(false);
        expect('actions' in session).toBe(false);
    });

    it('does not mount chat-session when chatStore is omitted', () => {
        const roots = makeTempProviderRoots();
        const renderer: TestRenderer = {
            id: 'renderer',
            copyToClipboardOSC52: () => true,
            isOsc52Supported: () => true,
        };
        const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
        let thrown: unknown;

        function Consumer(): JSX.Element {
            useChatSession();
            return null;
        }

        try {
            runInSolidRoot(() => {
                composeMissionControlProviderTree({
                    useRenderer: () => renderer,
                    keymapProvider,
                    runtimeOptions: makeRuntimeOptions(roots),
                    get children() {
                        return createComponent(Consumer, {});
                    },
                });
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(MissingTuiProviderError);
        if (thrown instanceof MissingTuiProviderError) {
            expect(thrown.providerName).toBe('TuiChatSession');
        }
    });
});
