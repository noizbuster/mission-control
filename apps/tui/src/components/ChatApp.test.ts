import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { describe, expect, it, vi } from 'vitest';
import { normalizeTerminalViewport } from '../platform/terminal-viewport.js';
import {
    bottomDockPolicyForTerminal,
    chatAppViewportLayout,
    preserveBlockReferences,
    promptPanelRepaintKey,
} from './ChatApp.js';
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

describe('preserveBlockReferences', () => {
    it('returns fresh block references when prev is empty (first render)', () => {
        const fresh = parseMessageBlocks('You: hi\nAssistant: hello');
        const result = preserveBlockReferences(fresh, []);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(fresh[0]);
        expect(result[1]).toBe(fresh[1]);
    });

    it('reuses every block reference when content is identical across calls', () => {
        const text = 'You: hi\nAssistant: hello';
        const prev = parseMessageBlocks(text);
        const fresh = parseMessageBlocks(text);
        // Fresh objects are NOT === prev objects (parseMessageBlocks always allocates).
        expect(fresh[0]).not.toBe(prev[0]);
        // After preservation, references are reused because content is unchanged.
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]);
        expect(result[1]).toBe(prev[1]);
    });

    it('gives only the last block a fresh reference when text is appended to it', () => {
        const prev = parseMessageBlocks('You: hi\nAssistant: he');
        const fresh = parseMessageBlocks('You: hi\nAssistant: hello');
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]); // unchanged block reuses reference
        expect(result[1]).not.toBe(prev[1]); // changed block gets fresh reference
        expect(result[1]).toBe(fresh[1]); // ... specifically the fresh one
        expect(result[1]?.lines).toEqual(['Assistant: hello']); // content correct
    });

    it('preserves references for unchanged leading blocks when a new block is appended', () => {
        const prev = parseMessageBlocks('You: q\nAssistant: a1');
        const fresh = parseMessageBlocks('You: q\nAssistant: a1\nYou: q2');
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]); // You: q unchanged
        expect(result[1]).toBe(prev[1]); // Assistant: a1 unchanged
        expect(result[2]).toBe(fresh[2]); // newly appended block, fresh reference
    });

    it('reuses a multi-line block whose lines are element-wise equal', () => {
        const prev = parseMessageBlocks('tool: foo\nTarget: x\n+added\n-removed');
        const fresh = parseMessageBlocks('tool: foo\nTarget: x\n+added\n-removed');
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(prev[0]);
    });

    it('does not reuse a block when the kind differs at the same index', () => {
        const prev: readonly ChatBlock[] = [{ kind: 'user', lines: ['You: x'] }];
        const fresh: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: x'] }];
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(fresh[0]);
        expect(result[0]).not.toBe(prev[0]);
    });

    it('does not reuse a block when line count differs at the same index', () => {
        const prev: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a', 'b'] }];
        const fresh: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a'] }];
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(fresh[0]);
        expect(result[0]).not.toBe(prev[0]);
    });

    it('does not reuse a block when a single line differs', () => {
        const prev: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a', 'b'] }];
        const fresh: readonly ChatBlock[] = [{ kind: 'assistant', lines: ['Assistant: a', 'c'] }];
        const result = preserveBlockReferences(fresh, prev);
        expect(result[0]).toBe(fresh[0]);
        expect(result[0]).not.toBe(prev[0]);
    });

    it('reuses leading references when fresh is shorter than prev (tail block dropped)', () => {
        const prev = parseMessageBlocks('You: q\nAssistant: a\nError: oops');
        const fresh = parseMessageBlocks('You: q\nAssistant: a');
        const result = preserveBlockReferences(fresh, prev);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(prev[0]);
        expect(result[1]).toBe(prev[1]);
    });

    it('returns an empty array for empty fresh and empty prev', () => {
        const result = preserveBlockReferences([], []);
        expect(result).toEqual([]);
    });
});

describe('bottomDockPolicyForTerminal', () => {
    it('builds policy from normalized terminal dimensions with deterministic fallbacks', () => {
        const fallback = bottomDockPolicyForTerminal(normalizeTerminalViewport({}));
        const wide = bottomDockPolicyForTerminal({ columns: 120, rows: 24 });

        expect([fallback.columns, fallback.rows, fallback.menu.rows]).toEqual([80, 24, 5]);
        expect([wide.columns, wide.rows, wide.menu.rows, wide.status.showSession]).toEqual([120, 24, 8, true]);
    });

    it('uses live viewport dimensions instead of stale process stdout dimensions', () => {
        const viewport = normalizeTerminalViewport({ width: 140, height: 40 });
        const policy = bottomDockPolicyForTerminal(viewport);

        expect([policy.columns, policy.rows, policy.menu.rows, policy.status.showSession]).toEqual([140, 40, 8, true]);
    });
});

describe('chatAppViewportLayout', () => {
    it('recomputes dock policy and root dimensions when the viewport shrinks from 100x30 to 60x15', () => {
        // Given: two consecutive normalized viewport readings from the terminal hook.
        const initial = chatAppViewportLayout(normalizeTerminalViewport({ width: 100, height: 30 }));
        const resized = chatAppViewportLayout(normalizeTerminalViewport({ width: 60, height: 15 }));

        // Then: both the numeric shell props and the dock policy follow the latest viewport.
        expect([
            initial.width,
            initial.height,
            initial.dockPolicy.columns,
            initial.dockPolicy.rows,
            initial.dockPolicy.widthClass,
            initial.dockPolicy.menu.rows,
            initial.dockPolicy.status.showSession,
        ]).toEqual([100, 30, 100, 30, 'normal', 5, true]);
        expect([
            resized.width,
            resized.height,
            resized.dockPolicy.columns,
            resized.dockPolicy.rows,
            resized.dockPolicy.widthClass,
            resized.dockPolicy.menu.rows,
            resized.dockPolicy.status.showSession,
            resized.welcomeAvailableRows,
        ]).toEqual([60, 15, 60, 15, 'narrow', 3, false, 9]);
        expect(resized.welcomeAvailableRows).toBe(resized.dockPolicy.transcript.rows);
    });

    it('keeps short-terminal rows non-negative and shell dimensions non-zero at 40x10', () => {
        // Given: a short but valid terminal viewport.
        const layout = chatAppViewportLayout(normalizeTerminalViewport({ width: 40, height: 10 }));
        const policy = layout.dockPolicy;

        // Then: the shell remains visible and every dock region has a valid row budget.
        expect([layout.width, layout.height]).toEqual([40, 10]);
        expect(layout.width).toBeGreaterThan(0);
        expect(layout.height).toBeGreaterThan(0);
        expect(policy.menu.rows).toBeGreaterThanOrEqual(0);
        expect(policy.status.rows).toBeGreaterThanOrEqual(0);
        expect(policy.input.rows).toBeGreaterThanOrEqual(0);
        expect(policy.transcript.rows).toBeGreaterThanOrEqual(0);
        expect(policy.transcript.rows + policy.menu.rows + policy.status.rows + policy.input.rows).toBe(policy.rows);
    });
});

describe('promptPanelRepaintKey', () => {
    it('changes when prompt-adjacent panel rows can shift around the native textarea', () => {
        expect(
            promptPanelRepaintKey({ inputMirror: '', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 5 }),
        ).toBe('none');
        expect(
            promptPanelRepaintKey({ inputMirror: '/', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 5 }),
        ).toBe('slash:/');
        expect(
            promptPanelRepaintKey({ inputMirror: '#', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 5 }),
        ).toBe('workflow:#');
        expect(
            promptPanelRepaintKey({ inputMirror: '@', fileAutocompleteOpen: true, fileMatchCount: 28, menuRows: 5 }),
        ).toBe('file:@:28');
        expect(
            promptPanelRepaintKey({ inputMirror: '/', fileAutocompleteOpen: false, fileMatchCount: 0, menuRows: 0 }),
        ).toBe('none');
    });
});

describe('ChatAppSplitShell topology', () => {
    it('keeps upper output, bottom dock, and modal overlays as ordered shell children', () => {
        const source = readChatAppSource();
        const shellBlock = sliceBetween(source, 'export function ChatAppSplitShell', 'export function ChatApp(');

        expect(shellBlock).toContain(
            '<box flexDirection="column" width={width} height={height} shouldFill={true} onMouseUp={onMouseUp}>',
        );
        expect(shellBlock).toContain('upperOutputRegion');
        expect(shellBlock).toContain('bottomDock');
        expect(shellBlock).toContain('modalOverlays');
        expect(shellBlock.indexOf('upperOutputRegion')).toBeLessThan(shellBlock.indexOf('bottomDock'));
        expect(shellBlock.indexOf('bottomDock')).toBeLessThan(shellBlock.indexOf('modalOverlays'));
    });
});

describe('ChatApp source topology', () => {
    it('uses the terminal viewport hook instead of renderer dimension polling', () => {
        const source = readChatAppSource();

        expect(source).toContain('useTerminalViewport');
        expect(source).toContain('chatAppViewportLayout(viewport())');
        expect(source).not.toContain('useRendererDimensions');
        expect(source).not.toContain('setInterval(sync, 250)');
    });

    it('requests a full OpenTUI repaint when terminal viewport columns or rows change', () => {
        const source = readChatAppSource();
        const viewportRepaintBlock = sliceBetween(source, 'let prevViewport = viewport();', 'let prevOverlayMode');

        expect(source).toContain("import { hardResetRendererSurface } from '../platform/opentui-renderer.js';");
        expect(viewportRepaintBlock).toContain('const currentViewport = viewport();');
        expect(viewportRepaintBlock).toContain('prevViewport.columns !== currentViewport.columns');
        expect(viewportRepaintBlock).toContain('prevViewport.rows !== currentViewport.rows');
        expect(viewportRepaintBlock).toContain('hardResetRendererSurface(renderer)');
    });

    it('wires ChatBottomDock exactly once with refs, focus, status layout, and menu policy', () => {
        const source = readChatAppSource();
        const dockBlock = sliceBetween(source, '<ChatBottomDock', '/>');

        expect(matchCount(source, '<ChatBottomDock')).toBe(1);
        expect(dockBlock).toContain('store={store}');
        expect(dockBlock).toContain('textareaRef={textareaHandle}');
        expect(dockBlock).toContain('scrollboxRef={scrollboxHandle}');
        expect(dockBlock).toContain('inputFocused={!overlayActive()}');
        expect(dockBlock).toContain('viewportColumns={viewport().columns}');
        expect(dockBlock).toContain('viewportRows={viewport().rows}');
        expect(dockBlock).toContain('statusLayout={dockStatusLayout()}');
        expect(dockBlock).toContain('menuPolicy={dockPolicy().menu}');
    });

    it('keeps transcript output, spinner, toast, and minimap inside the upper output region', () => {
        const source = readChatAppSource();
        const upperBlock = sliceBetween(source, 'upperOutputRegion={', 'bottomDock={');

        expect(upperBlock).toContain('<WelcomeScreen');
        expect(upperBlock).toContain('viewportColumns={viewport().columns}');
        expect(upperBlock).toContain('availableRows={viewportLayout().welcomeAvailableRows}');
        expect(upperBlock).toContain('transcript');
        expect(upperBlock).toContain('<AgentSpinner');
        expect(upperBlock).toContain('<Toast');
        expect(upperBlock).toContain('<AbgMinimap');
    });

    it('uses provider-backed clipboard and toast services instead of local ad-hoc services', () => {
        const source = readChatAppSource();

        expect(source).toContain('useTuiClipboard');
        expect(source).toContain('useTuiToast');
        expect(source).toContain('useTuiLocalPreferences');
        expect(source).not.toContain('createClipboardService(renderer)');
        expect(source).not.toContain('const [toast, setToast]');
        expect(source).not.toContain('new ModelFrecency()');
        expect(source).not.toContain('new ModelFavorites()');
    });

    it('derives the welcome row budget from the live viewport dock policy without stdout row reads', () => {
        const source = readChatAppSource();
        const layoutBlock = sliceBetween(
            source,
            'export function chatAppViewportLayout',
            'export function promptPanelRepaintKey',
        );
        const welcomeBlock = sliceBetween(source, '<WelcomeScreen', '/>');
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');

        expect(layoutBlock).toContain('welcomeAvailableRows: dockPolicy.transcript.rows');
        expect(welcomeBlock).toContain('availableRows={viewportLayout().welcomeAvailableRows}');
        expect(source).not.toContain(stdoutRowsToken);
    });

    it('threads the terminal viewport into ABG overlay and minimap renderers', () => {
        const source = readChatAppSource();
        const abgOverlayBlock = sliceBetween(source, '<AbgOverlay', '/>');
        const upperBlock = sliceBetween(source, 'upperOutputRegion={', 'bottomDock={');

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

    it('keeps full-screen overlays as early returns before the dock shell', () => {
        const source = readChatAppSource();
        const shellIndex = source.indexOf('<ChatAppSplitShell');

        expect(source.indexOf("snapshot.overlayMode === 'abg'")).toBeLessThan(shellIndex);
        expect(source.indexOf("snapshot.overlayMode === 'diff-viewer'")).toBeLessThan(shellIndex);
        expect(source.indexOf("snapshot.overlayMode === 'models-overlay'")).toBeLessThan(shellIndex);
        expect(matchCount(source, 'width={shellWidth()} height={shellHeight()}')).toBeGreaterThanOrEqual(4);
        expect(source).toContain('width={shellWidth()}');
        expect(source).toContain('height={shellHeight()}');
    });

    it('keeps modal overlays in ChatApp through ModalPopup after the dock sibling', () => {
        const source = readChatAppSource();
        const modalStart = source.indexOf('modalOverlays={');
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
});
