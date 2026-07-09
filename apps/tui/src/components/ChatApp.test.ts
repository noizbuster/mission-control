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

describe('ChatApp normal root layout topology', () => {
    it('does not define or render ChatAppSplitShell', () => {
        const source = readChatAppSource();

        expect(source).not.toContain('ChatAppSplitShell');
    });

    it('inlines the root box with viewport dimensions and the selection mouse-up handler', () => {
        const source = readChatAppSource();

        expect(source).toContain(
            '<box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true} onMouseUp={handleSelectionMouseUp}>',
        );
    });

    it('keeps upper output region, bottom dock, and modal overlays as ordered root children', () => {
        const source = readChatAppSource();
        const rootBoxIndex = source.indexOf(
            '<box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true} onMouseUp={handleSelectionMouseUp}>',
        );
        expect(rootBoxIndex).toBeGreaterThanOrEqual(0);

        const rootBlock = source.slice(rootBoxIndex);
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
        const source = readChatAppSource();
        const dockBlock = sliceBetween(source, '<ChatBottomDock', '/>');

        expect(matchCount(source, '<ChatBottomDock')).toBe(1);
        expect(dockBlock).toContain('store={store}');
        expect(dockBlock).toContain('textareaRef={textareaHandle}');
        expect(dockBlock).toContain('scrollboxRef={scrollboxHandle}');
        expect(dockBlock).toContain('inputFocused={!overlayActive()}');
        expect(dockBlock).toContain('viewportColumns={viewport().columns}');
        expect(dockBlock).toContain('viewportRows={viewport().rows}');
        expect(dockBlock).not.toContain('statusLayout=');
        expect(dockBlock).not.toContain('menuPolicy=');
    });

    it('keeps transcript output, spinner, toast, and minimap inside the upper output region', () => {
        const source = readChatAppSource();
        const upperBlock = sliceBetween(source, 'const upperOutputRegion', 'const bottomDock');

        expect(upperBlock).toContain('<WelcomeScreen');
        expect(upperBlock).toContain('viewportColumns={viewport().columns}');
        expect(upperBlock).toContain('availableRows={dockPolicy().transcript.rows}');
        expect(upperBlock).toContain('transcript');
        expect(upperBlock).toContain('<AgentSpinner');
        expect(upperBlock).toContain('<Toast');
        expect(upperBlock).toContain('<AbgMinimap');
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
        const source = readChatAppSource();
        const welcomeBlock = sliceBetween(source, '<WelcomeScreen', '/>');
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');

        expect(welcomeBlock).toContain('availableRows={dockPolicy().transcript.rows}');
        expect(source).not.toContain(stdoutRowsToken);
    });

    it('threads the terminal viewport into ABG overlay and minimap renderers', () => {
        const source = readChatAppSource();
        const abgOverlayBlock = sliceBetween(source, '<AbgOverlay', '/>');
        const upperBlock = sliceBetween(source, 'const upperOutputRegion', 'const bottomDock');

        expect(abgOverlayBlock).toContain('viewport={viewport()}');
        expect(upperBlock).toContain('<AbgMinimap store={abgOverlayController.store} viewport={viewport()} />');
    });

    it('does not import or directly render prompt-adjacent popover panels', () => {
        const source = readChatAppSource();

        expect(source).not.toContain('./SlashMenuPanel.js');
        expect(source).not.toContain('./FileAutocompletePanel.js');
        expect(source).not.toContain('<SlashMenuPanel');
        expect(source).not.toContain('<FileAutocompletePanel');
    });

    it('keeps full-screen overlays as early returns before the normal root layout', () => {
        const source = readChatAppSource();
        const rootBoxIndex = source.indexOf(
            '<box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true} onMouseUp={handleSelectionMouseUp}>',
        );
        expect(rootBoxIndex).toBeGreaterThanOrEqual(0);

        expect(source.indexOf("snap.overlayMode === 'abg'")).toBeLessThan(rootBoxIndex);
        expect(source.indexOf("snap.overlayMode === 'diff-viewer'")).toBeLessThan(rootBoxIndex);
        expect(source.indexOf("snap.overlayMode === 'models-overlay'")).toBeLessThan(rootBoxIndex);
        expect(matchCount(source, 'width={viewport().columns} height={viewport().rows}')).toBeGreaterThanOrEqual(4);
        expect(source).toContain('width={viewport().columns}');
        expect(source).toContain('height={viewport().rows}');
    });

    it('keeps modal overlays in ChatApp through ModalPopup after the dock sibling', () => {
        const source = readChatAppSource();
        const modalStart = source.indexOf('const modalOverlays');
        expect(modalStart).toBeGreaterThanOrEqual(0);
        const modalBlock = source.slice(modalStart);

        for (const mode of [
            'approval',
            'model-picker',
            'level-picker',
            'rename',
            'session-picker',
            'agents-dashboard',
            'mission-panel',
        ]) {
            expect(modalBlock).toContain(`snap.overlayMode === '${mode}'`);
        }
        expect(matchCount(modalBlock, '<ModalPopup>')).toBe(7);
        expect(modalBlock).toContain('<ApprovalOverlay store={store} />');
        expect(modalBlock).toContain('<MissionPanelOverlay');
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
});
