import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { normalizeTerminalViewport } from '../platform/terminal-viewport.js';
import { createChatStore } from '../state/chat-store.js';
import {
    bottomDockPolicyForTerminal,
    ChatAppSplitShell,
    chatAppViewportLayout,
    preserveBlockReferences,
    promptPanelRepaintKey,
} from './ChatApp.js';
import { ChatBottomDock } from './ChatBottomDock.js';
import { bottomDockPolicy } from './chat-bottom-dock-policy.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
} from './chat-test-support.js';
import { statusBarLayoutFromPolicy } from './StatusBar.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readChatAppSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatApp.tsx'), 'utf8');
}

function childAt(children: readonly ReactNode[], index: number): ReactNode {
    const child = children.at(index);
    if (child === undefined) {
        throw new Error(`missing child at index ${index}`);
    }
    return child;
}

function propsFor<TProps>(node: ReactNode, type: string | ((props: TProps) => ReactNode)): TProps {
    if (!isValidElement<TProps>(node)) {
        throw new Error('expected a React element');
    }
    expect(node.type).toBe(type);
    return node.props;
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
    it('constructs the upper output region above a single bottom dock sibling and leaves modals outside the dock', () => {
        const store = createChatStore();
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
        const policy = bottomDockPolicy({ columns: 120, rows: 24 });
        const upperOutputRegion = createElement('text', { key: 'upper' }, 'upper output');
        const bottomDock = createElement(ChatBottomDock, {
            store,
            textareaRef,
            scrollboxRef,
            statusLayout: statusBarLayoutFromPolicy(policy),
            menuPolicy: policy.menu,
        });
        const modalOverlays = createElement('box', { key: 'modal' }, createElement('text', undefined, 'modal'));

        const shell = ChatAppSplitShell({
            width: 60,
            height: 15,
            onMouseUp: () => {},
            upperOutputRegion,
            bottomDock,
            modalOverlays,
        });

        const shellProps = propsFor<{
            readonly children?: ReactNode;
            readonly width?: number;
            readonly height?: number;
            readonly shouldFill?: boolean;
        }>(shell, 'box');
        expect([shellProps.width, shellProps.height]).toEqual([60, 15]);
        expect(shellProps.shouldFill).toBe(true);
        const children = Children.toArray(shellProps.children);
        const upperProps = propsFor<{
            readonly children?: ReactNode;
            readonly flexGrow?: number;
            readonly shouldFill?: boolean;
        }>(childAt(children, 0), 'box');
        expect([upperProps.flexGrow, upperProps.shouldFill]).toEqual([1, true]);
        expect(upperProps.children).toBe(upperOutputRegion);
        expect(propsFor(childAt(children, 1), ChatBottomDock)).toMatchObject({ store, textareaRef, scrollboxRef });
        const modalProps = propsFor<{ readonly children?: ReactNode }>(childAt(children, 2), 'box');
        const modalChildren = Children.toArray(modalProps.children);
        expect(propsFor<{ readonly children?: string }>(childAt(modalChildren, 0), 'text').children).toBe('modal');
    });
});

describe('ChatApp source topology', () => {
    it('uses the terminal viewport hook instead of renderer dimension polling', () => {
        const source = readChatAppSource();

        expect(source).toContain('useTerminalViewport');
        expect(source).toContain('chatAppViewportLayout(viewport)');
        expect(source).not.toContain('useRendererDimensions');
        expect(source).not.toContain('setInterval(sync, 250)');
    });

    it('requests a full OpenTUI repaint when terminal viewport columns or rows change', () => {
        const source = readChatAppSource();
        const viewportRepaintBlock = sliceBetween(source, 'const prevViewport', 'const prevOverlayMode');

        expect(source).toContain("import { hardResetRendererSurface } from '../platform/opentui-renderer.js';");
        expect(viewportRepaintBlock).toContain('useRef(viewport)');
        expect(viewportRepaintBlock).toContain('prevViewport.current.columns !== viewport.columns');
        expect(viewportRepaintBlock).toContain('prevViewport.current.rows !== viewport.rows');
        expect(viewportRepaintBlock).toContain('hardResetRendererSurface(renderer)');
        expect(viewportRepaintBlock).toContain('[viewport, renderer]');
    });

    it('wires ChatBottomDock exactly once with refs, focus, status layout, and menu policy', () => {
        const source = readChatAppSource();
        const dockBlock = sliceBetween(source, '<ChatBottomDock', '/>');

        expect(matchCount(source, '<ChatBottomDock')).toBe(1);
        expect(dockBlock).toContain('store={store}');
        expect(dockBlock).toContain('textareaRef={textareaRef}');
        expect(dockBlock).toContain('scrollboxRef={scrollboxRef}');
        expect(dockBlock).toContain('inputFocused={!overlayActive}');
        expect(dockBlock).toContain('viewportColumns={viewport.columns}');
        expect(dockBlock).toContain('viewportRows={viewport.rows}');
        expect(dockBlock).toContain('statusLayout={dockStatusLayout}');
        expect(dockBlock).toContain('menuPolicy={dockPolicy.menu}');
    });

    it('keeps transcript output, spinner, toast, and minimap inside the upper output region', () => {
        const source = readChatAppSource();
        const upperBlock = sliceBetween(source, 'upperOutputRegion={', 'bottomDock={');

        expect(upperBlock).toContain('<WelcomeScreen');
        expect(upperBlock).toContain('viewportColumns={viewport.columns}');
        expect(upperBlock).toContain('availableRows={viewportLayout.welcomeAvailableRows}');
        expect(upperBlock).toContain('transcript');
        expect(upperBlock).toContain('<AgentSpinner');
        expect(upperBlock).toContain('<Toast');
        expect(upperBlock).toContain('<AbgMinimap');
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
        expect(welcomeBlock).toContain('availableRows={viewportLayout.welcomeAvailableRows}');
        expect(source).not.toContain(stdoutRowsToken);
    });

    it('threads the terminal viewport into ABG overlay and minimap renderers', () => {
        const source = readChatAppSource();
        const abgOverlayBlock = sliceBetween(source, '<AbgOverlay', '/>');
        const upperBlock = sliceBetween(source, 'upperOutputRegion={', 'bottomDock={');

        expect(abgOverlayBlock).toContain('viewport={viewport}');
        expect(upperBlock).toContain('<AbgMinimap store={abgOverlayController.store} viewport={viewport} />');
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
        expect(matchCount(source, 'width={shellWidth} height={shellHeight}')).toBeGreaterThanOrEqual(4);
        expect(source).toContain('width={shellWidth}');
        expect(source).toContain('height={shellHeight}');
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
            expect(modalBlock).toContain(`snapshot.overlayMode === '${mode}'`);
        }
        expect(matchCount(modalBlock, '<ModalPopup>')).toBe(7);
        expect(modalBlock).toContain('<ApprovalOverlay store={store} />');
        expect(modalBlock).toContain('<MissionPanelOverlay');
    });
});
