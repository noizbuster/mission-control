import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const appDir = 'apps/tui/src/app';
const chatAppDir = appDir;
const chatAppRootFile = 'apps/tui/src/app.tsx';
const createChatTuiFile = 'apps/tui/src/create-chat-tui.tsx';
const testFilePattern = /\.(test|spec)\.(ts|tsx)$/u;

const ROOT_BOX_NEEDLE = 'width={dimensions().width}';

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


function collectAppModuleFiles(): readonly string[] {
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

function readAppTopologyUnion(): string {
    const moduleSources = collectAppModuleFiles().map((path) => readSource(path));
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

describe('App multi-file topology union', () => {
    it('scans app.tsx plus every non-test app module', () => {
        const modules = collectAppModuleFiles();
        expect(modules.length).toBeGreaterThanOrEqual(12);
        expect(modules).toContain(join(chatAppDir, 'NormalLayout.tsx'));
        expect(modules).toContain(join(chatAppDir, 'ModalOverlays.tsx'));
        expect(modules).toContain(join(chatAppDir, 'FullscreenOverlays.tsx'));
        expect(modules).toContain(join(chatAppDir, 'use-keymap-layers.ts'));
        expect(modules).toContain(join(chatAppDir, 'use-global-keyboard.ts'));
        expect(modules).toContain(join(chatAppDir, 'use-repaint-effects.ts'));
        expect(modules.every((path) => !testFilePattern.test(path))).toBe(true);
    });

    it('does not define or render ChatAppSplitShell anywhere in the app surface', () => {
        const union = readAppTopologyUnion();
        expect(union).not.toContain('ChatAppSplitShell');
        expect(union).not.toContain('AppShell');
    });

    it('does not import or render SlashMenu/FileAutocomplete in app modules', () => {
        const union = readAppTopologyUnion();
        expect(union).not.toContain('./SlashMenuPanel.js');
        expect(union).not.toContain('./FileAutocompletePanel.js');
        expect(union).not.toContain('../SlashMenuPanel.js');
        expect(union).not.toContain('../FileAutocompletePanel.js');
        expect(union).not.toContain('<SlashMenuPanel');
        expect(union).not.toContain('<FileAutocompletePanel');
    });

    it('uses provider hooks instead of ad-hoc clipboard/toast/frecency construction', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const union = readAppTopologyUnion();

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

    it('never reads process.stdout rows/columns from the app surface', () => {
        const union = readAppTopologyUnion();
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');
        const stdoutColumnsToken = ['process', 'stdout', 'columns'].join('.');
        expect(union).not.toContain(stdoutRowsToken);
        expect(union).not.toContain(stdoutColumnsToken);
    });
});

describe('AppProps and mount shape', () => {
    it('declares AppProps with only store', () => {
        const source = readSource(chatAppRootFile);
        const propsBlock = sliceBetween(source, 'export type AppProps = {', '};');

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

    it('mounts via createComponent(App, { store }) only under MissionControlTuiProviders', () => {
        const source = readSource(createChatTuiFile);

        expect(source).toContain('createComponent(MissionControlTuiProviders');
        expect(source).toContain('createComponent(App, { store })');
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

describe('App thin composer topology', () => {
    it('thins App to hooks plus fullscreen vs normal branch', () => {
        const source = readSource(chatAppRootFile);

        expect(source).toContain('useTerminalDimensions');
        expect(source).not.toContain('useRendererDimensions');
        expect(source).not.toContain('setInterval(sync, 250)');
        expect(source).toContain('FullscreenOverlays');
        expect(source).toContain('UpperRegion');
        expect(source).toContain('ChatBottomDock');
        expect(source).toContain('useGlobalKeyboard');
        expect(source).toContain('useKeymapLayers');
        expect(source).toContain('useRepaintEffects');
        expect(source).toContain('useSubmit');
        expect(source).toContain('useTransientToast');
        expect(source).toContain('useSelectionMouseUp');
        expect(source).toContain('useRenderableHandles');
        expect(source).not.toContain('function AgentSpinner');
        expect(source).not.toContain('function ModalPopup');
        expect(source).not.toContain('<NormalLayout');
        expect(source).not.toContain('<ModalPopup');
        expect(source).not.toContain('useKeyboard');
        expect(source).not.toContain('onMount(');
        expect(source).not.toContain('syncShellSize');
        expect(source).not.toContain("import('../platform/keymap/");
        expect(source).not.toContain('hardResetRendererSurface(renderer)');
        expect(matchCount(source, 'useKeymapLayers')).toBe(2);
    });

    it('branches fullscreen vs normal via Show with OpenCode flex siblings', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const fullscreenSource = readSource(join(chatAppDir, 'FullscreenOverlays.tsx'));

        expect(chatAppSource).toContain('<Show');
        expect(chatAppSource).toContain('isFullscreenOverlay');
        expect(chatAppSource).toContain('<FullscreenOverlays');
        expect(chatAppSource).toContain('<ChatBottomDock');
        expect(chatAppSource).toContain('flexGrow={1}');
        expect(chatAppSource).toContain('minHeight={0}');
        expect(chatAppSource).toContain('flexShrink={0}');
        expect(chatAppSource).not.toContain('createMemo((): JSX.Element');
        expect(chatAppSource).not.toContain('const transcript = createMemo');
        expect(chatAppSource).not.toContain('const rootContent = createMemo');

        for (const mode of FULLSCREEN_MODES) {
            expect(fullscreenSource).toContain(`snap.overlayMode === '${mode}'`);
        }
        expect(fullscreenSource).toContain('ABG overlay unavailable in this session.');
    });
});

describe('App OpenCode layout wiring', () => {
    it('pins App root to dimensions().width/height like OpenCode', () => {
        const appSource = readSource(chatAppRootFile);
        expect(appSource).toContain(ROOT_BOX_NEEDLE);
        expect(appSource).toContain('height={dimensions().height}');
        expect(appSource).toContain('useTerminalDimensions');
        expect(appSource).toContain('onMouseUp={handleSelectionMouseUp}');
        expect(appSource).not.toContain('syncShellSize');
        expect(appSource).not.toContain("process.on('SIGWINCH'");
        expect(appSource).toContain('flexGrow={1}');
        expect(appSource).toContain('minHeight={0}');
        expect(appSource).toContain('flexShrink={0}');
        expect(appSource).toContain('<ChatBottomDock');
    });

    it('keeps upper output region, bottom dock, and modal overlays as ordered body children', () => {
        const appSource = readSource(chatAppRootFile);
        const upperIndex = appSource.indexOf('<UpperRegion');
        const dockIndex = appSource.indexOf('<ChatBottomDock');
        const modalIndex = appSource.indexOf('<ModalOverlays');

        expect(upperIndex).toBeGreaterThanOrEqual(0);
        expect(dockIndex).toBeGreaterThan(upperIndex);
        expect(modalIndex).toBeGreaterThan(dockIndex);
    });

    it('wires ChatBottomDock with refs and focus (live dimensions inside dock)', () => {
        const appSource = readSource(chatAppRootFile);
        const dockSource = readSource(resolve(root, 'apps/tui/src/components/ChatBottomDock.tsx'));
        const dockBlock = sliceBetween(appSource, '<ChatBottomDock', '/>');

        expect(matchCount(appSource, '<ChatBottomDock')).toBe(1);
        expect(dockBlock).toContain('store={props.store}');
        expect(dockBlock).toContain('textareaRef={textareaHandle}');
        expect(dockBlock).toContain('scrollboxRef={scrollboxHandle}');
        expect(dockBlock).toContain('inputFocused={!overlayActive()}');
        expect(dockSource).toContain('useTerminalDimensions');
        expect(dockSource).toContain('dimensions().width');
        expect(dockSource).toContain('dimensions().height');
    });

    it('keeps dock as a flexShrink sibling of the flexGrow upper region', () => {
        const appSource = readSource(chatAppRootFile);
        const mainStart = appSource.indexOf('function AppMain');
        const mainSource = appSource.slice(mainStart);
        const upperBox = mainSource.indexOf('flexGrow={1}');
        const dockBox = mainSource.indexOf('flexShrink={0}');
        const dock = mainSource.indexOf('<ChatBottomDock');
        expect(upperBox).toBeGreaterThanOrEqual(0);
        expect(dockBox).toBeGreaterThan(upperBox);
        expect(dock).toBeGreaterThan(dockBox);
    });

    it('derives welcome row budget from live dimensions inside UpperRegion', () => {
        const upperSource = readSource(join(chatAppDir, 'UpperRegion.tsx'));

        expect(upperSource).toContain('useTerminalDimensions');
        expect(upperSource).toContain('bottomDockPolicy');
        expect(upperSource).toContain('availableRows={availableRows()}');
        expect(upperSource).toContain('viewportColumns={dimensions().width}');
        expect(upperSource).not.toContain('props.availableRows');
        expect(upperSource).not.toContain('props.viewport');
    });
});

describe('UpperRegion and fullscreen feature inventory', () => {
    it('keeps transcript output, spinner, toast, and minimap inside the upper output region', () => {
        const upperSource = readSource(join(chatAppDir, 'UpperRegion.tsx'));

        expect(upperSource).toContain('flexGrow={1} minHeight={0}');
        expect(upperSource).toContain('<WelcomeScreen');
        expect(upperSource).toContain('viewportColumns={dimensions().width}');
        expect(upperSource).toContain('availableRows={availableRows()}');
        expect(upperSource).toContain('props.transcript');
        expect(upperSource).toContain('<AgentSpinner');
        expect(upperSource).toContain('<Toast');
        expect(upperSource).toContain('<AbgMinimap');
        expect(upperSource).not.toContain('<>');
    });

    it('threads the terminal viewport into ABG overlay and minimap renderers', () => {
        const fullscreenSource = readSource(join(chatAppDir, 'FullscreenOverlays.tsx'));
        const upperSource = readSource(join(chatAppDir, 'UpperRegion.tsx'));
        const abgOverlayBlock = sliceBetween(fullscreenSource, '<AbgOverlay', '/>');

        expect(abgOverlayBlock).toContain('viewport={props.viewport}');
        expect(upperSource).toContain('useTerminalDimensions');
        expect(upperSource).toContain('dimensions().width');
        expect(upperSource).toContain('dimensions().height');
        expect(upperSource).toContain('<AbgMinimap');
        expect(fullscreenSource).toContain('diff-viewer');
        expect(fullscreenSource).toContain('models-overlay');
        expect(fullscreenSource).toContain('<ModelsOverlay');
    });
});

describe('ModalOverlays seven ModalPopup modes', () => {
    it('keeps all seven modal modes through ModalPopup after the dock sibling', () => {
        const modalSource = readSource(join(chatAppDir, 'ModalOverlays.tsx'));
        const appSource = readSource(chatAppRootFile);

        for (const mode of MODAL_MODES) {
            expect(modalSource).toContain(`overlayMode === '${mode}'`);
        }
        expect(matchCount(modalSource, '<ModalPopup>')).toBe(7);
        expect(modalSource).toContain('<ApprovalOverlay store={props.store} />');
        expect(modalSource).toContain('<MissionPanelOverlay');
        expect(appSource.indexOf('<ChatBottomDock')).toBeLessThan(appSource.indexOf('<ModalOverlays'));
    });
});

describe('keyboard and keymap layer topology', () => {
    it('routes global keyboard sink Ctrl+C through use-global-keyboard', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const keyboardSource = readSource(join(chatAppDir, 'use-global-keyboard.ts'));

        expect(chatAppSource).toContain('useGlobalKeyboard');
        expect(keyboardSource).toContain('useKeyboard');
        expect(keyboardSource).toContain("key.ctrl && key.name === 'c'");
        expect(keyboardSource).toContain("key.name === 'escape' || (key.ctrl && key.name === 'g')");
        expect(keyboardSource).toContain('textareaHandle.get()?.focused');
    });

    it('registers keymap layers only in use-keymap-layers', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const keymapSource = readSource(join(chatAppDir, 'use-keymap-layers.ts'));

        expect(chatAppSource).toContain('useKeymapLayers');
        expect(chatAppSource).not.toContain('registerManagedTextareaComposition');
        expect(chatAppSource).not.toContain('registerChatSubmitLayer');

        for (const name of KEYMAP_LAYER_NEEDLES) {
            expect(keymapSource).toContain(name);
        }
        expect(matchCount(keymapSource, 'registerMessagesScrollLayer')).toBe(2);
        expect(matchCount(keymapSource, 'registerSelectionCopyLayer')).toBe(2);
        expect(keymapSource).toContain("import('../platform/keymap/");
        expect(keymapSource).not.toContain('KeymapProvider');
    });
});

describe('repaint effects topology', () => {
    it('pins requestRender on discrete UI transitions without forceFullRepaint or intervals', () => {
        const chatAppSource = readSource(chatAppRootFile);
        const repaintSource = readSource(join(chatAppDir, 'use-repaint-effects.ts'));
        const repaintCall = sliceBetween(chatAppSource, 'useRepaintEffects({', '});');

        expect(chatAppSource).toContain('useRepaintEffects');
        expect(repaintCall).toContain('renderer');
        expect(repaintCall).toContain('overlayMode');
        expect(repaintCall).toContain('generating');
        expect(repaintCall).toContain('promptRepaintKey');
        expect(repaintCall).not.toContain('viewport');
        expect(repaintSource).toContain('renderer.requestRender()');
        expect(repaintSource).not.toContain('forceFullRepaintRequested');
        expect(repaintSource).not.toContain('setInterval');
        expect(repaintSource).not.toContain('}, 500)');
        expect(repaintSource).not.toContain('hardResetRendererSurface');
        expect(repaintSource).not.toContain('viewport');
        expect(repaintSource).toContain('prevOverlayMode');
        expect(repaintSource).toContain('prevPromptRepaintKey');
        expect(repaintSource).toContain('prevGenerating');
    });
});

describe('app import-graph invariants', () => {
    it('App imports layout and hooks only from ./app/', () => {
        const source = readSource(chatAppRootFile);
        const importLines = source
            .split('\n')
            .filter((line) => line.includes("from './app/") || line.includes('from "./app/'));

        expect(importLines.some((line) => line.includes('FullscreenOverlays'))).toBe(true);
        expect(importLines.some((line) => line.includes('UpperRegion'))).toBe(true);
        expect(importLines.some((line) => line.includes('ModalOverlays'))).toBe(true);
        expect(importLines.some((line) => line.includes('use-global-keyboard'))).toBe(true);
        expect(importLines.some((line) => line.includes('use-keymap-layers'))).toBe(true);
        expect(importLines.some((line) => line.includes('use-repaint-effects'))).toBe(true);
        expect(source).toContain("from './components/ChatBottomDock.js'");
        expect(source).not.toContain("from './AgentSpinner");
        expect(source).not.toContain("from './ModalPopup");
        expect(source).not.toContain("from './NormalLayout");
    });

    it('layout modules do not reintroduce dual prop fan-out from create-chat-tui', () => {
        const createSource = readSource(createChatTuiFile);
        const chatAppSource = readSource(chatAppRootFile);

        expect(createSource).toContain('createComponent(App, { store })');
        expect(chatAppSource).toMatch(/export function App\(props:\s*AppProps\)/);
        expect(chatAppSource).toContain('useChatSession()');
    });
});
