import { describe, expect, it, vi } from 'vitest';

vi.mock('@mission-control/tui', async () => await import('./terminal-text'));
vi.mock('@mission-control/tui/chat', async () => await import('./chat'));
vi.mock('@mission-control/core', () => ({
    ContinuationRuntime: class ContinuationRuntime {},
    MAIN_AGENT_ID: 'main',
    readBoulder: () => undefined,
    resolveMissionControlDataDir: () => '/tmp/mission-control-test',
    resolveUserConfigDir: () => '/tmp/mission-control-test-config',
}));
vi.mock('@opentui/keymap/solid', () => ({ useKeymap: () => undefined }));
vi.mock('@opentui/solid', () => ({
    useRenderer: () => undefined,
    useTerminalDimensions: () => undefined,
}));
vi.mock('solid-js', () => ({
    Show: () => undefined,
    createMemo: () => () => [],
    createSignal: () => [() => 0, () => undefined],
    createEffect: () => undefined,
    createContext: () => ({ Provider: () => undefined }),
    useContext: () => undefined,
    onCleanup: () => undefined,
}));
vi.mock('./app/FullscreenOverlays', () => ({ FullscreenOverlays: () => undefined }));
vi.mock('./app/ModalOverlays', () => ({ ModalOverlays: () => undefined }));
vi.mock('./app/UpperRegion', () => ({ UpperRegion: () => undefined }));
vi.mock('./app/use-global-keyboard', () => ({ useGlobalKeyboard: () => undefined }));
vi.mock('./app/use-keymap-layers', () => ({ useKeymapLayers: () => undefined }));
vi.mock('./app/use-renderable-handles', () => ({ useRenderableHandles: () => undefined }));
vi.mock('./app/use-repaint-effects', () => ({ useRepaintEffects: () => undefined }));
vi.mock('./app/use-selection-mouseup', () => ({ useSelectionMouseUp: () => undefined }));
vi.mock('./app/use-submit', () => ({ useSubmit: () => undefined }));
vi.mock('./app/use-transient-toast', () => ({ useTransientToast: () => undefined }));
vi.mock('./components/ChatBottomDock', () => ({ ChatBottomDock: () => undefined }));
vi.mock('./components/ChatTranscript', () => ({ ChatTranscript: () => undefined }));
vi.mock('./components/chat-bottom-dock-policy', () => ({ bottomDockPolicy: () => undefined }));
vi.mock('./components/chat-theme', () => ({ CHAT_BG: '' }));
vi.mock('./components/dialog/dialog', () => ({
    DialogOverlay: () => undefined,
    DialogProvider: () => undefined,
}));
vi.mock('./platform/keymap/keymap-chrome', () => ({ KeymapChrome: () => undefined }));
vi.mock('./platform/providers/index', () => ({
    useChatSession: () => undefined,
    useTuiClipboard: () => undefined,
    useTuiLocalPreferences: () => undefined,
    useTuiPromptStash: () => undefined,
    useTuiRuntime: () => undefined,
}));
vi.mock('./platform/use-solid-store-selector', () => ({ useSolidStoreSelector: () => undefined }));

/**
 * Re-export smoke only. Multi-file topology pins live in
 * `app/app-topology.test.ts`.
 */
describe('App public re-export surface', () => {
    it('re-exports pure helpers from app-helpers', async () => {
        const chatApp = await import('./app');
        const helpers = await import('./app/app-helpers');

        expect(chatApp.deriveStatusBarProps).toBe(helpers.deriveStatusBarProps);
        expect(chatApp.preserveBlockReferences).toBe(helpers.preserveBlockReferences);
        expect(chatApp.promptPanelRepaintKey).toBe(helpers.promptPanelRepaintKey);
        expect(chatApp.parseModelPreferenceKeys).toBe(helpers.parseModelPreferenceKeys);
        expect(chatApp.recentModelPreferenceSelections).toBe(helpers.recentModelPreferenceSelections);
        expect(typeof chatApp.App).toBe('function');
    });
});
