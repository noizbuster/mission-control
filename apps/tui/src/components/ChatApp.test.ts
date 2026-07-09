import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@mission-control/tui', async () => await import('../terminal-text.js'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat.js'));
vi.mock('@mission-control/core', () => ({
    ContinuationRuntime: class ContinuationRuntime {},
    MAIN_AGENT_ID: 'main',
    readBoulder: () => undefined,
    resolveMissionControlDataDir: () => '/tmp/mission-control-test',
    resolveUserConfigDir: () => '/tmp/mission-control-test-config',
}));

function readChatAppSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatApp.tsx'), 'utf8');
}

function readChatRepaintEffectsSource(): string {
    return readFileSync(
        resolve(process.cwd(), 'apps/tui/src/components/chat-app/use-chat-repaint-effects.ts'),
        'utf8',
    );
}

function readChatAppModuleSource(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components', relativePath), 'utf8');
}

function readChatAppTopologyUnion(): string {
    return [
        readChatAppSource(),
        readChatRepaintEffectsSource(),
        readChatAppModuleSource('chat-app/use-chat-transient-toast.ts'),
        readChatAppModuleSource('chat-app/use-chat-selection-mouseup.ts'),
        readChatAppModuleSource('chat-app/use-chat-submit.ts'),
        readChatAppModuleSource('chat-app/use-chat-renderable-handles.ts'),
        readChatAppModuleSource('chat-app/use-chat-global-keyboard.ts'),
        readChatAppModuleSource('chat-app/use-chat-keymap-layers.ts'),
        readChatAppModuleSource('chat-app/ChatNormalLayout.tsx'),
        readChatAppModuleSource('chat-app/ChatUpperRegion.tsx'),
        readChatAppModuleSource('chat-app/ChatModalOverlays.tsx'),
        readChatAppModuleSource('chat-app/ChatFullscreenOverlays.tsx'),
        readChatAppModuleSource('chat-app/AgentSpinner.tsx'),
        readChatAppModuleSource('chat-app/ModalPopup.tsx'),
    ].join('\n');
}

function matchCount(source: string, needle: string): number {
    return source.split(needle).length - 1;
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
    const start = source.indexOf(startNeedle);
    const end = source.indexOf(endNeedle, start);
    if (start < 0 || end < 0) {
        throw new Error(`missing source slice ${startNeedle}..${endNeedle}`);
    }
    return source.slice(start, end);
}

const ROOT_BOX_NEEDLE =
    '<box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} shouldFill={true} onMouseUp={props.onMouseUp}>';

describe('ChatApp normal root layout topology', () => {
    it('does not define or render ChatAppSplitShell', () => {
        const union = readChatAppTopologyUnion();

        expect(union).not.toContain('ChatAppSplitShell');
    });

    it('pins the root box with viewport dimensions and the selection mouse-up handler in ChatNormalLayout', () => {
        const layoutSource = readChatAppModuleSource('chat-app/ChatNormalLayout.tsx');

        expect(layoutSource).toContain(ROOT_BOX_NEEDLE);
    });

    it('keeps upper output region, bottom dock, and modal overlays as ordered root children', () => {
        const layoutSource = readChatAppModuleSource('chat-app/ChatNormalLayout.tsx');
        const rootBoxIndex = layoutSource.indexOf(ROOT_BOX_NEEDLE);
        expect(rootBoxIndex).toBeGreaterThanOrEqual(0);

        const rootBlock = layoutSource.slice(rootBoxIndex);
        const upperIndex = rootBlock.indexOf('upperOutputRegion');
        const dockIndex = rootBlock.indexOf('bottomDock');
        const modalIndex = rootBlock.indexOf('modalOverlays');

        expect(upperIndex).toBeGreaterThanOrEqual(0);
        expect(dockIndex).toBeGreaterThan(upperIndex);
        expect(modalIndex).toBeGreaterThan(dockIndex);
    });
});

describe('ChatApp source topology', () => {
    it('uses the terminal viewport hook instead of renderer dimension polling', () => {
        const source = readChatAppSource();

        expect(source).toContain('useTerminalViewport');
        expect(source).not.toContain('useRendererDimensions');
        expect(source).not.toContain('setInterval(sync, 250)');
    });

    it('requests a full OpenTUI repaint when terminal viewport columns or rows change', () => {
        const chatAppSource = readChatAppSource();
        const repaintSource = readChatRepaintEffectsSource();
        const union = readChatAppTopologyUnion();
        const viewportRepaintBlock = sliceBetween(
            repaintSource,
            'let prevViewport = viewport();',
            'let prevOverlayMode',
        );

        expect(chatAppSource).toContain('useChatRepaintEffects');
        expect(chatAppSource).not.toContain('hardResetRendererSurface(renderer)');
        expect(chatAppSource).not.toContain("Reflect.set(renderer, 'forceFullRepaintRequested'");
        expect(repaintSource).toContain('hardResetRendererSurface');
        expect(repaintSource).toContain("Reflect.set(renderer, 'forceFullRepaintRequested', true)");
        expect(repaintSource).toContain('}, 500)');
        expect(union).toContain('hardResetRendererSurface(renderer)');
        expect(viewportRepaintBlock).toContain('const currentViewport = viewport();');
        expect(viewportRepaintBlock).toContain('prevViewport.columns !== currentViewport.columns');
        expect(viewportRepaintBlock).toContain('prevViewport.rows !== currentViewport.rows');
        expect(viewportRepaintBlock).toContain('hardResetRendererSurface(renderer)');
    });

    it('wires ChatBottomDock exactly once with refs, focus, and raw viewport dimensions', () => {
        const layoutSource = readChatAppModuleSource('chat-app/ChatNormalLayout.tsx');
        const dockBlock = sliceBetween(layoutSource, '<ChatBottomDock', '/>');

        expect(matchCount(layoutSource, '<ChatBottomDock')).toBe(1);
        expect(dockBlock).toContain('store={props.store}');
        expect(dockBlock).toContain('textareaRef={props.textareaHandle}');
        expect(dockBlock).toContain('scrollboxRef={props.scrollboxHandle}');
        expect(dockBlock).toContain('inputFocused={!props.overlayActive}');
        expect(dockBlock).toContain('viewportColumns={props.viewport.columns}');
        expect(dockBlock).toContain('viewportRows={props.viewport.rows}');
        expect(dockBlock).not.toContain('statusLayout=');
        expect(dockBlock).not.toContain('menuPolicy=');
    });

    it('keeps transcript output, spinner, toast, and minimap inside the upper output region', () => {
        const upperSource = readChatAppModuleSource('chat-app/ChatUpperRegion.tsx');

        expect(upperSource).toContain('<WelcomeScreen');
        expect(upperSource).toContain('viewportColumns={props.viewport.columns}');
        expect(upperSource).toContain('availableRows={props.availableRows}');
        expect(upperSource).toContain('props.transcript');
        expect(upperSource).toContain('<AgentSpinner');
        expect(upperSource).toContain('<Toast');
        expect(upperSource).toContain('<AbgMinimap');
    });

    it('uses provider-backed clipboard and toast services instead of local ad-hoc services', () => {
        const source = readChatAppSource();
        const union = readChatAppTopologyUnion();

        expect(source).toContain('useTuiClipboard');
        expect(union).toContain('useTuiToast');
        expect(source).toContain('useTuiLocalPreferences');
        expect(union).not.toContain('createClipboardService(renderer)');
        expect(union).not.toContain('const [toast, setToast]');
        expect(union).not.toContain('new ModelFrecency()');
        expect(union).not.toContain('new ModelFavorites()');
    });

    it('derives the welcome row budget from the live viewport dock policy without stdout row reads', () => {
        const layoutSource = readChatAppModuleSource('chat-app/ChatNormalLayout.tsx');
        const upperSource = readChatAppModuleSource('chat-app/ChatUpperRegion.tsx');
        const union = readChatAppTopologyUnion();
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');

        expect(layoutSource).toContain('availableRows={props.dockPolicy.transcript.rows}');
        expect(upperSource).toContain('availableRows={props.availableRows}');
        expect(union).not.toContain(stdoutRowsToken);
    });

    it('threads the terminal viewport into ABG overlay and minimap renderers', () => {
        const fullscreenSource = readChatAppModuleSource('chat-app/ChatFullscreenOverlays.tsx');
        const upperSource = readChatAppModuleSource('chat-app/ChatUpperRegion.tsx');
        const abgOverlayBlock = sliceBetween(fullscreenSource, '<AbgOverlay', '/>');

        expect(abgOverlayBlock).toContain('viewport={viewport}');
        expect(upperSource).toContain(
            '<AbgMinimap store={props.abgOverlayController.store} viewport={props.viewport} />',
        );
    });

    it('does not import or directly render prompt-adjacent popover panels', () => {
        const union = readChatAppTopologyUnion();

        expect(union).not.toContain('./SlashMenuPanel.js');
        expect(union).not.toContain('./FileAutocompletePanel.js');
        expect(union).not.toContain('<SlashMenuPanel');
        expect(union).not.toContain('<FileAutocompletePanel');
    });

    it('keeps full-screen overlays as early returns before the normal root layout', () => {
        const chatAppSource = readChatAppSource();
        const fullscreenSource = readChatAppModuleSource('chat-app/ChatFullscreenOverlays.tsx');
        const normalLayoutIndex = chatAppSource.indexOf('<ChatNormalLayout');
        expect(normalLayoutIndex).toBeGreaterThanOrEqual(0);

        expect(chatAppSource.indexOf("snap.overlayMode === 'abg'")).toBeLessThan(normalLayoutIndex);
        expect(chatAppSource.indexOf("snap.overlayMode === 'diff-viewer'")).toBeLessThan(normalLayoutIndex);
        expect(chatAppSource.indexOf("snap.overlayMode === 'models-overlay'")).toBeLessThan(normalLayoutIndex);
        expect(fullscreenSource).toContain("snap.overlayMode === 'abg'");
        expect(fullscreenSource).toContain("snap.overlayMode === 'diff-viewer'");
        expect(fullscreenSource).toContain("snap.overlayMode === 'models-overlay'");
        expect(fullscreenSource).toContain('ABG overlay unavailable in this session.');
        expect(matchCount(fullscreenSource, 'width={viewport.columns} height={viewport.rows}')).toBeGreaterThanOrEqual(
            3,
        );
    });

    it('keeps modal overlays through ModalPopup after the dock sibling', () => {
        const modalSource = readChatAppModuleSource('chat-app/ChatModalOverlays.tsx');
        const layoutSource = readChatAppModuleSource('chat-app/ChatNormalLayout.tsx');

        for (const mode of [
            'approval',
            'model-picker',
            'level-picker',
            'rename',
            'session-picker',
            'agents-dashboard',
            'mission-panel',
        ]) {
            expect(modalSource).toContain(`overlayMode === '${mode}'`);
        }
        expect(matchCount(modalSource, '<ModalPopup>')).toBe(7);
        expect(modalSource).toContain('<ApprovalOverlay store={store} />');
        expect(modalSource).toContain('<MissionPanelOverlay');
        expect(layoutSource.indexOf('bottomDock')).toBeLessThan(layoutSource.indexOf('modalOverlays'));
    });

    it('routes global keyboard sink and keymap layers through single chat-app hooks', () => {
        const chatAppSource = readChatAppSource();
        const keyboardSource = readChatAppModuleSource('chat-app/use-chat-global-keyboard.ts');
        const keymapSource = readChatAppModuleSource('chat-app/use-chat-keymap-layers.ts');

        expect(chatAppSource).toContain('useChatGlobalKeyboard');
        expect(chatAppSource).toContain('useChatKeymapLayers');
        expect(matchCount(chatAppSource, 'useChatKeymapLayers')).toBe(2);
        expect(chatAppSource).not.toContain('useKeyboard');
        expect(chatAppSource).not.toContain('onMount(');
        expect(chatAppSource).not.toContain("import('../platform/keymap/");

        expect(keyboardSource).toContain('useKeyboard');
        expect(keyboardSource).toContain("key.ctrl && key.name === 'c'");
        expect(keyboardSource).toContain("key.name === 'escape' || (key.ctrl && key.name === 'g')");
        expect(keyboardSource).toContain('textareaHandle.get()?.focused');

        for (const name of [
            'registerManagedTextareaComposition',
            'registerChatSubmitLayer',
            'registerMessagesScrollLayer',
            'registerSelectionCopyLayer',
            'registerModelShortcutsLayer',
            'registerSessionShortcutsLayer',
            'registerMessageUndoRedoLayer',
            'registerAbgMinimapToggleLayer',
            "name: 'menu.up'",
            "name: 'menu.down'",
            'priority: 200',
        ]) {
            expect(keymapSource).toContain(name);
        }
        expect(matchCount(keymapSource, 'registerMessagesScrollLayer')).toBe(2);
        expect(matchCount(keymapSource, 'registerSelectionCopyLayer')).toBe(2);
        expect(keymapSource).toContain("import('../../platform/keymap/");
        expect(keymapSource).not.toContain('KeymapProvider');
    });

    it('thins ChatApp to a composer that branches fullscreen vs normal layout', () => {
        const source = readChatAppSource();

        expect(source).toContain('ChatFullscreenOverlays');
        expect(source).toContain('ChatNormalLayout');
        expect(source).not.toContain('function AgentSpinner');
        expect(source).not.toContain('function ModalPopup');
        expect(source).not.toContain('<ChatBottomDock');
        expect(source).not.toContain('<ModalPopup');
    });
});
