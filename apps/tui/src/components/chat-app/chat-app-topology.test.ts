import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const componentsDir = 'apps/tui/src/components';
const chatAppDir = join(componentsDir, 'chat-app');
const chatAppRootFile = join(componentsDir, 'ChatApp.tsx');
const createChatTuiFile = 'apps/tui/src/create-chat-tui.tsx';
const testFilePattern = /\.(test|spec)\.(ts|tsx)$/u;

const ROOT_BOX_NEEDLE =
    '<box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows} shouldFill={true} onMouseUp={props.onMouseUp}>';

const MODAL_MODES = [
    'approval',
    'model-picker',
    'level-picker',
    'rename',
    'session-picker',
    'agents-dashboard',
    'mission-panel',
] as const;

const FULLSCREEN_MODES = ['abg', 'diff-viewer', 'models-overlay'] as const;

const KEYMAP_LAYER_NEEDLES = [
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
] as const;

const PROVIDER_HOOK_NEEDLES = [
    'useTuiClipboard',
    'useTuiToast',
    'useTuiLocalPreferences',
    'useTuiPromptStash',
    'useTuiRuntime',
    'useChatSession',
] as const;

function readSource(relativePath: string): string {
    return readFileSync(resolve(root, relativePath), 'utf8');
}

function collectChatAppModuleFiles(): readonly string[] {
    const absoluteDir = resolve(root, chatAppDir);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDir)) {
        if (testFilePattern.test(entry)) continue;
        const relativePath = join(chatAppDir, entry);
        const absolutePath = resolve(root, relativePath);
        if (!statSync(absolutePath).isFile()) continue;
        if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
            files.push(relativePath);
        }
    }
    return files.sort();
}

function readChatAppTopologyUnion(): string {
    const moduleSources = collectChatAppModuleFiles().map((path) => readSource(path));
    return [readSource(chatAppRootFile), ...moduleSources].join('\n');
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

describe('ChatApp multi-file topology union', () => {
    it('scans ChatApp.tsx plus every non-test chat-app module', () => {
        const modules = collectChatAppModuleFiles();
        expect(modules.length).toBeGreaterThanOrEqual(12);
        expect(modules).toContain(join(chatAppDir, 'ChatNormalLayout.tsx'));
        expect(modules).toContain(join(chatAppDir, 'ChatModalOverlays.tsx'));
        expect(modules).toContain(join(chatAppDir, 'ChatFullscreenOverlays.tsx'));
        expect(modules).toContain(join(chatAppDir, 'use-chat-keymap-layers.ts'));
        expect(modules).toContain(join(chatAppDir, 'use-chat-global-keyboard.ts'));
        expect(modules).toContain(join(chatAppDir, 'use-chat-repaint-effects.ts'));
        expect(modules.every((path) => !testFilePattern.test(path))).toBe(true);
    });

    it('does not define or render ChatAppSplitShell anywhere in the chat-app surface', () => {
        const union = readChatAppTopologyUnion();
        expect(union).not.toContain('ChatAppSplitShell');
        expect(union).not.toContain('AppShell');
    });

    it('does not import or render SlashMenu/FileAutocomplete in chat-app modules', () => {
        const union = readChatAppTopologyUnion();
        expect(union).not.toContain('./SlashMenuPanel.js');
        expect(union).not.toContain('./FileAutocompletePanel.js');
        expect(union).not.toContain('../SlashMenuPanel.js');
        expect(union).not.toContain('../FileAutocompletePanel.js');
        expect(union).not.toContain('<SlashMenuPanel');
        expect(union).not.toContain('<FileAutocompletePanel');
    });

    it('uses provider hooks instead of ad-hoc clipboard/toast/frecency construction', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const union = readChatAppTopologyUnion();

        for (const hook of PROVIDER_HOOK_NEEDLES) {
            expect(union).toContain(hook);
        }
        expect(chatAppSource).toContain('useTuiClipboard');
        expect(chatAppSource).toContain('useTuiLocalPreferences');
        expect(chatAppSource).toContain('useTuiPromptStash');
        expect(chatAppSource).toContain('useChatSession');
        expect(union).not.toContain('createClipboardService(renderer)');
        expect(union).not.toContain('const [toast, setToast]');
        expect(union).not.toContain('new ModelFrecency()');
        expect(union).not.toContain('new ModelFavorites()');
    });

    it('never reads process.stdout rows/columns from the chat-app surface', () => {
        const union = readChatAppTopologyUnion();
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');
        const stdoutColumnsToken = ['process', 'stdout', 'columns'].join('.');
        expect(union).not.toContain(stdoutRowsToken);
        expect(union).not.toContain(stdoutColumnsToken);
    });
});

describe('ChatAppProps and mount shape', () => {
    it('declares ChatAppProps with only store', () => {
        const source = readSource(chatAppRootFile);
        const propsBlock = sliceBetween(source, 'export type ChatAppProps = {', '};');

        expect(propsBlock).toContain('readonly store: ChatStore');
        expect(propsBlock).not.toContain('textareaRef');
        expect(propsBlock).not.toContain('scrollboxRef');
        expect(propsBlock).not.toContain('welcomeData');
        expect(propsBlock).not.toContain('abgOverlayController');
        expect(propsBlock).not.toContain('missionControlServices');
        expect(propsBlock).not.toContain('actions');
        expect(propsBlock).not.toContain('statusBarProps');
        expect(matchCount(propsBlock, 'readonly ')).toBe(1);
    });

    it('mounts via createComponent(ChatApp, { store }) only under MissionControlTuiProviders', () => {
        const source = readSource(createChatTuiFile);

        expect(source).toContain('createComponent(MissionControlTuiProviders');
        expect(source).toContain('createComponent(ChatApp, { store })');
        expect(source).toContain("await import('@mission-control/tui/providers')");
        expect(source).not.toContain('textareaRef:');
        expect(source).not.toContain('scrollboxRef:');
        expect(source).not.toContain('statusBarProps');
        expect(source).not.toContain('welcomeData');
        expect(source).not.toContain('setTextareaRef');
        expect(source).not.toContain('setScrollboxRef');
        expect(source).not.toContain('abgOverlayController:');
        expect(source).not.toContain('missionControlServices:');
        expect(source).not.toContain('actions:');
    });
});

describe('ChatApp thin composer topology', () => {
    it('thins ChatApp to hooks plus fullscreen vs normal branch', () => {
        const source = readSource(chatAppRootFile);

        expect(source).toContain('useTerminalViewport');
        expect(source).not.toContain('useRendererDimensions');
        expect(source).not.toContain('setInterval(sync, 250)');
        expect(source).toContain('ChatFullscreenOverlays');
        expect(source).toContain('ChatNormalLayout');
        expect(source).toContain('useChatGlobalKeyboard');
        expect(source).toContain('useChatKeymapLayers');
        expect(source).toContain('useChatRepaintEffects');
        expect(source).toContain('useChatSubmit');
        expect(source).toContain('useChatTransientToast');
        expect(source).toContain('useChatSelectionMouseUp');
        expect(source).toContain('useChatRenderableHandles');
        expect(source).not.toContain('function AgentSpinner');
        expect(source).not.toContain('function ModalPopup');
        expect(source).not.toContain('<ChatBottomDock');
        expect(source).not.toContain('<ModalPopup');
        expect(source).not.toContain('useKeyboard');
        expect(source).not.toContain('onMount(');
        expect(source).not.toContain("import('../platform/keymap/");
        expect(source).not.toContain('hardResetRendererSurface(renderer)');
        expect(source).not.toContain("Reflect.set(renderer, 'forceFullRepaintRequested'");
        expect(matchCount(source, 'useChatKeymapLayers')).toBe(2);
    });

    it('keeps full-screen overlays as early returns before the normal root layout', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const fullscreenSource = readSource(join(chatAppDir, 'ChatFullscreenOverlays.tsx'));
        const normalLayoutIndex = chatAppSource.indexOf('<ChatNormalLayout');
        expect(normalLayoutIndex).toBeGreaterThanOrEqual(0);

        for (const mode of FULLSCREEN_MODES) {
            expect(chatAppSource.indexOf(`snap.overlayMode === '${mode}'`)).toBeLessThan(normalLayoutIndex);
            expect(fullscreenSource).toContain(`snap.overlayMode === '${mode}'`);
        }
        expect(fullscreenSource).toContain('ABG overlay unavailable in this session.');
        expect(matchCount(fullscreenSource, 'width={viewport.columns} height={viewport.rows}')).toBeGreaterThanOrEqual(
            3,
        );
    });
});

describe('ChatNormalLayout order and dock wiring', () => {
    it('pins the root box with viewport dimensions and selection mouse-up handler', () => {
        const layoutSource = readSource(join(chatAppDir, 'ChatNormalLayout.tsx'));
        expect(layoutSource).toContain(ROOT_BOX_NEEDLE);
    });

    it('keeps upper output region, bottom dock, and modal overlays as ordered root children', () => {
        const layoutSource = readSource(join(chatAppDir, 'ChatNormalLayout.tsx'));
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

    it('wires ChatBottomDock exactly once with refs, focus, and raw viewport dimensions', () => {
        const layoutSource = readSource(join(chatAppDir, 'ChatNormalLayout.tsx'));
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

    it('derives welcome row budget from dock policy without stdout row reads', () => {
        const layoutSource = readSource(join(chatAppDir, 'ChatNormalLayout.tsx'));
        const upperSource = readSource(join(chatAppDir, 'ChatUpperRegion.tsx'));

        expect(layoutSource).toContain('availableRows={props.dockPolicy.transcript.rows}');
        expect(upperSource).toContain('availableRows={props.availableRows}');
    });
});

describe('ChatUpperRegion and fullscreen feature inventory', () => {
    it('keeps transcript output, spinner, toast, and minimap inside the upper output region', () => {
        const upperSource = readSource(join(chatAppDir, 'ChatUpperRegion.tsx'));

        expect(upperSource).toContain('<WelcomeScreen');
        expect(upperSource).toContain('viewportColumns={props.viewport.columns}');
        expect(upperSource).toContain('availableRows={props.availableRows}');
        expect(upperSource).toContain('props.transcript');
        expect(upperSource).toContain('<AgentSpinner');
        expect(upperSource).toContain('<Toast');
        expect(upperSource).toContain('<AbgMinimap');
    });

    it('threads the terminal viewport into ABG overlay and minimap renderers', () => {
        const fullscreenSource = readSource(join(chatAppDir, 'ChatFullscreenOverlays.tsx'));
        const upperSource = readSource(join(chatAppDir, 'ChatUpperRegion.tsx'));
        const abgOverlayBlock = sliceBetween(fullscreenSource, '<AbgOverlay', '/>');

        expect(abgOverlayBlock).toContain('viewport={viewport}');
        expect(upperSource).toContain(
            '<AbgMinimap store={props.abgOverlayController.store} viewport={props.viewport} />',
        );
        expect(fullscreenSource).toContain('diff-viewer');
        expect(fullscreenSource).toContain('models-overlay');
        expect(fullscreenSource).toContain('<ModelsOverlay');
    });
});

describe('ChatModalOverlays seven ModalPopup modes', () => {
    it('keeps all seven modal modes through ModalPopup after the dock sibling', () => {
        const modalSource = readSource(join(chatAppDir, 'ChatModalOverlays.tsx'));
        const layoutSource = readSource(join(chatAppDir, 'ChatNormalLayout.tsx'));

        for (const mode of MODAL_MODES) {
            expect(modalSource).toContain(`overlayMode === '${mode}'`);
        }
        expect(matchCount(modalSource, '<ModalPopup>')).toBe(7);
        expect(modalSource).toContain('<ApprovalOverlay store={store} />');
        expect(modalSource).toContain('<MissionPanelOverlay');
        expect(layoutSource.indexOf('bottomDock')).toBeLessThan(layoutSource.indexOf('modalOverlays'));
    });
});

describe('keyboard and keymap layer topology', () => {
    it('routes global keyboard sink Ctrl+C through use-chat-global-keyboard', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const keyboardSource = readSource(join(chatAppDir, 'use-chat-global-keyboard.ts'));

        expect(chatAppSource).toContain('useChatGlobalKeyboard');
        expect(keyboardSource).toContain('useKeyboard');
        expect(keyboardSource).toContain("key.ctrl && key.name === 'c'");
        expect(keyboardSource).toContain("key.name === 'escape' || (key.ctrl && key.name === 'g')");
        expect(keyboardSource).toContain('textareaHandle.get()?.focused');
    });

    it('registers keymap layers only in use-chat-keymap-layers', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const keymapSource = readSource(join(chatAppDir, 'use-chat-keymap-layers.ts'));

        expect(chatAppSource).toContain('useChatKeymapLayers');
        expect(chatAppSource).not.toContain('registerManagedTextareaComposition');
        expect(chatAppSource).not.toContain('registerChatSubmitLayer');

        for (const name of KEYMAP_LAYER_NEEDLES) {
            expect(keymapSource).toContain(name);
        }
        expect(matchCount(keymapSource, 'registerMessagesScrollLayer')).toBe(2);
        expect(matchCount(keymapSource, 'registerSelectionCopyLayer')).toBe(2);
        expect(keymapSource).toContain("import('../../platform/keymap/");
        expect(keymapSource).not.toContain('KeymapProvider');
    });
});

describe('repaint effects topology', () => {
    it('pins hardReset + forceFullRepaint + 500ms in use-chat-repaint-effects', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const repaintSource = readSource(join(chatAppDir, 'use-chat-repaint-effects.ts'));
        const union = readChatAppTopologyUnion();
        const viewportRepaintBlock = sliceBetween(
            repaintSource,
            'let prevViewport = viewport();',
            'let prevOverlayMode',
        );

        expect(chatAppSource).toContain('useChatRepaintEffects');
        expect(repaintSource).toContain('hardResetRendererSurface');
        expect(repaintSource).toContain("Reflect.set(renderer, 'forceFullRepaintRequested', true)");
        expect(repaintSource).toContain('}, 500)');
        expect(union).toContain('hardResetRendererSurface(renderer)');
        expect(viewportRepaintBlock).toContain('const currentViewport = viewport();');
        expect(viewportRepaintBlock).toContain('prevViewport.columns !== currentViewport.columns');
        expect(viewportRepaintBlock).toContain('prevViewport.rows !== currentViewport.rows');
        expect(viewportRepaintBlock).toContain('hardResetRendererSurface(renderer)');
    });
});

describe('chat-app import-graph invariants', () => {
    it('ChatApp imports layout and hooks only from ./chat-app/', () => {
        const source = readSource(chatAppRootFile);
        const importLines = source
            .split('\n')
            .filter((line) => line.includes("from './chat-app/") || line.includes('from "./chat-app/'));

        expect(importLines.some((line) => line.includes('ChatFullscreenOverlays'))).toBe(true);
        expect(importLines.some((line) => line.includes('ChatNormalLayout'))).toBe(true);
        expect(importLines.some((line) => line.includes('use-chat-global-keyboard'))).toBe(true);
        expect(importLines.some((line) => line.includes('use-chat-keymap-layers'))).toBe(true);
        expect(importLines.some((line) => line.includes('use-chat-repaint-effects'))).toBe(true);
        expect(source).not.toContain("from './AgentSpinner");
        expect(source).not.toContain("from './ModalPopup");
        expect(source).not.toContain("from './ChatBottomDock");
    });

    it('layout modules do not reintroduce dual prop fan-out from create-chat-tui', () => {
        const createSource = readSource(createChatTuiFile);
        const chatAppSource = readSource(chatAppRootFile);

        expect(createSource).toContain('createComponent(ChatApp, { store })');
        expect(chatAppSource).toMatch(/export function ChatApp\(\{\s*store\s*\}:\s*ChatAppProps\)/);
        expect(chatAppSource).toContain('useChatSession()');
    });
});
