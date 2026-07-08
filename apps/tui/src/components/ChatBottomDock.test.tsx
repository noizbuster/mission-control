/** @jsxImportSource @opentui/react */

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatSelectorStore } from '../state/chat-selector-store.js';
import { createChatStore } from '../state/chat-store.js';
import { createSlashCommandMenuState } from '../state/interactive-chat-command-menu.js';
import { ChatBottomDockBase, selectChatBottomDockSlice } from './ChatBottomDock.js';
import {
    baseStatusProps,
    childAt,
    dockNodeForSlice,
    dockPromptPanelChildren,
    dockSliceWith,
    elementChildren,
    expectMenuPolicyProps,
    fileChoiceRowCount,
    fileFooter,
    firstDockPanelProps,
    openFileAutocompleteState,
    overlayFrameProps,
    propsFor,
    slashChoiceRowCount,
    slashFooter,
    statusLayout,
} from './ChatBottomDock.test-support.js';
import { ChatInputArea, type ChatInputAreaProps } from './ChatInputArea.js';
import { bottomDockPolicy } from './chat-bottom-dock-policy.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
} from './chat-test-support.js';
import { FileAutocompletePanel, type FileAutocompletePanelProps } from './FileAutocompletePanel.js';
import { QuestionOverlay } from './OverlayPanels.js';
import { Separator, type SeparatorProps } from './Separator.js';
import { SlashMenuPanel, type SlashMenuPanelProps } from './SlashMenuPanel.js';
import { BottomStatusBar, type StatusBarProps, TopStatusBar } from './StatusBar.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readChatInputAreaSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatInputArea.tsx'), 'utf8');
}

describe('ChatBottomDockBase composition', () => {
    it('constructs normal input mode in status, panel, input, status order', () => {
        // Given: a normal chat store with live status fields and prompt-adjacent content.
        const store = createChatStore();
        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-high' });
        store.setSessionId('session_123');
        store.setApprovalLevel('safe');
        store.setContextTokensUsed(12345);
        store.setContextTokensMax(200000);
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
        const onCopySessionID = vi.fn();
        const promptAdjacentPanel = (
            <box>
                <text>panel slot</text>
            </box>
        );

        // When: the pure construction seam is called with the selected dock slice.
        const node = ChatBottomDockBase({
            store,
            textareaRef,
            scrollboxRef,
            viewportColumns: 121,
            viewportRows: 40,
            statusBarProps: baseStatusProps(onCopySessionID),
            statusLayout,
            promptAdjacentPanel,
            dockSlice: selectChatBottomDockSlice(store.getSnapshot()),
        });

        // Then: the dock composes the expected children and passes runtime refs/status through.
        const children = elementChildren(node);
        expect(children.length).toBe(5);
        const topStatusProps = propsFor<StatusBarProps>(childAt(children, 0), TopStatusBar);
        expect([
            topStatusProps.providerID,
            topStatusProps.modelID,
            topStatusProps.variantID,
            topStatusProps.contextTokensUsed,
            topStatusProps.contextTokensMax,
            topStatusProps.statusLayout,
        ]).toEqual(['openai', 'gpt-5', 'reasoning-high', 12345, 200000, statusLayout]);
        expect(dockPromptPanelChildren(node).length).toBe(1);
        const separatorProps = propsFor<SeparatorProps>(childAt(children, 2), Separator);
        expect([separatorProps.state, separatorProps.width]).toEqual(['idle', 121]);
        const inputProps = propsFor<ChatInputAreaProps>(childAt(children, 3), ChatInputArea);
        expect([inputProps.store, inputProps.textareaRef, inputProps.scrollboxRef, inputProps.focused]).toEqual([
            store,
            textareaRef,
            scrollboxRef,
            true,
        ]);
        expect(inputProps.viewportRows).toBe(40);
        const bottomStatusProps = propsFor<StatusBarProps>(childAt(children, 4), BottomStatusBar);
        expect([
            bottomStatusProps.sessionID,
            bottomStatusProps.approvalLevel,
            bottomStatusProps.onCopySessionID,
            bottomStatusProps.statusLayout,
        ]).toEqual(['session_123', 'safe', onCopySessionID, statusLayout]);
    });

    it('constructs question mode with QuestionOverlay in the input slot', () => {
        // Given: the only overlay mode allowed inside the dock input slot.
        const store = createChatStore();
        void store.showQuestion('Pick one', ['Yes', 'No'], { header: 'Question' });
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        // When: the dock is constructed from the question snapshot.
        const node = ChatBottomDockBase({
            store,
            textareaRef,
            scrollboxRef,
            viewportColumns: 80,
            viewportRows: 24,
            statusBarProps: baseStatusProps(),
            dockSlice: selectChatBottomDockSlice(store.getSnapshot()),
        });

        // Then: the question panel occupies the input slot instead of ChatInputArea.
        const children = elementChildren(node);
        expect(children.length).toBe(4);
        const separatorProps = propsFor<SeparatorProps>(childAt(children, 1), Separator);
        expect([separatorProps.state, separatorProps.width]).toEqual(['awaiting_input', 80]);
        const questionProps = propsFor<{ readonly store: ReturnType<typeof createChatStore> }>(
            childAt(children, 2),
            QuestionOverlay,
        );
        expect(questionProps.store).toBe(store);
    });

    it('keeps modal overlays out of the dock selector', () => {
        // Given: an approval overlay, which remains a ChatApp modal concern.
        const store = createChatStore();
        store.showApproval('bash.run', 'run tests');
        const textareaRef = asTextareaRef(createRecordingTextarea());
        const scrollboxRef = asScrollboxRef(createRecordingScrollbox());

        // When: the dock is constructed from the approval snapshot.
        const node = ChatBottomDockBase({
            store,
            textareaRef,
            scrollboxRef,
            viewportColumns: 80,
            viewportRows: 24,
            statusBarProps: baseStatusProps(),
            inputFocused: false,
            dockSlice: selectChatBottomDockSlice(store.getSnapshot()),
        });

        // Then: it still renders ChatInputArea with caller-owned focus and no approval modal child appears.
        const children = elementChildren(node);
        const separatorProps = propsFor<SeparatorProps>(childAt(children, 1), Separator);
        const inputProps = propsFor<ChatInputAreaProps>(childAt(children, 2), ChatInputArea);
        expect([children.length, separatorProps.state, inputProps.focused]).toEqual([4, 'awaiting_input', false]);
    });
});

describe('ChatBottomDockBase separator', () => {
    it('derives separator state from the selected slice and width from viewport columns', () => {
        const node = dockNodeForSlice(
            dockSliceWith({ separatorState: 'running' }),
            bottomDockPolicy({ columns: 120, rows: 24 }).menu,
            undefined,
            40,
        );
        const children = elementChildren(node);

        const separatorProps = propsFor<SeparatorProps>(childAt(children, 1), Separator);
        expect([separatorProps.state, separatorProps.width]).toEqual(['running', 40]);
    });
});

describe('ChatInputArea viewport contract', () => {
    it('uses injected viewportRows for PgUp/PgDn scroll and does not read process stdout rows', () => {
        const source = readChatInputAreaSource();
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');

        expect(source).toContain('viewportRows');
        expect(source).toContain('halfPageScrollDelta(viewportRows)');
        expect(source).not.toContain(stdoutRowsToken);
    });
});

describe('ChatBottomDockBase prompt-adjacent panels', () => {
    it('renders the slash menu through the dock with policy-derived rows and footer', () => {
        // Given: a wide dock policy with more rows than the direct slash-panel default.
        const policy = bottomDockPolicy({ columns: 120, rows: 24 });
        const node = dockNodeForSlice(
            dockSliceWith({ inputMirror: '/', menuState: createSlashCommandMenuState() }),
            policy.menu,
        );

        // Then: SlashMenuPanel is dock-owned and receives the policy-derived menu settings.
        const slashProps = firstDockPanelProps<SlashMenuPanelProps>(node, SlashMenuPanel);
        expectMenuPolicyProps(slashProps, policy.menu);
        const renderedSlash = SlashMenuPanel(slashProps);
        expect(slashChoiceRowCount(renderedSlash)).toBe(policy.menu.rows);
        expect(overlayFrameProps(renderedSlash).footer).toBe(slashFooter);
    });

    it('renders the workflow menu through the dock and hides the footer when policy says so', () => {
        // Given: a narrow dock policy that still permits menu rows but hides footer help.
        const policy = bottomDockPolicy({ columns: 40, rows: 24 });
        const workflowNames = ['default', 'planner', 'runner', 'audit', 'release'];
        const node = dockNodeForSlice(
            dockSliceWith({ inputMirror: '#', menuState: createSlashCommandMenuState(), workflowNames }),
            policy.menu,
        );

        // Then: the same panel seam renders workflow choices with the narrow row budget and no footer.
        const slashProps = firstDockPanelProps<SlashMenuPanelProps>(node, SlashMenuPanel);
        expect(slashProps.workflowNames).toBe(workflowNames);
        expectMenuPolicyProps(slashProps, policy.menu);
        const renderedWorkflow = SlashMenuPanel(slashProps);
        expect(overlayFrameProps(renderedWorkflow).title).toBe('Workflows (5)');
        expect(slashChoiceRowCount(renderedWorkflow)).toBe(policy.menu.rows);
        expect(overlayFrameProps(renderedWorkflow).footer).toBeUndefined();
    });

    it('renders file autocomplete through the dock with policy-derived rows and footer', () => {
        // Given: an open file autocomplete state and a wide dock row budget.
        const policy = bottomDockPolicy({ columns: 120, rows: 24 });
        const fileAutocomplete = openFileAutocompleteState(12);
        const node = dockNodeForSlice(dockSliceWith({ inputMirror: '@file', fileAutocomplete }), policy.menu);

        // Then: FileAutocompletePanel is dock-owned and bounded by the policy menu rows.
        const fileProps = firstDockPanelProps<FileAutocompletePanelProps>(node, FileAutocompletePanel);
        expect(fileProps.fileAutocomplete).toBe(fileAutocomplete);
        expectMenuPolicyProps(fileProps, policy.menu);
        const renderedFiles = FileAutocompletePanel(fileProps);
        expect(fileChoiceRowCount(renderedFiles)).toBe(policy.menu.rows);
        expect(overlayFrameProps(renderedFiles).footer).toBe(fileFooter);
    });

    it('omits prompt-adjacent menu panels when the policy has zero menu rows', () => {
        // Given: the minimum reserved dock height, which leaves no rows for menus.
        const policy = bottomDockPolicy({ columns: 80, rows: 7 });

        // When: slash and file autocomplete states would normally open a panel.
        const nodes = [
            dockNodeForSlice(
                dockSliceWith({ inputMirror: '/', menuState: createSlashCommandMenuState() }),
                policy.menu,
            ),
            dockNodeForSlice(
                dockSliceWith({ inputMirror: '@file', fileAutocomplete: openFileAutocompleteState(3) }),
                policy.menu,
            ),
        ];

        // Then: the dock renders status/input/status only, avoiding a negative-height or overflow-like panel.
        expect(policy.menu.rows).toBe(0);
        expect(nodes.map((node) => elementChildren(node).length)).toEqual([4, 4]);
        const inputProps = propsFor<ChatInputAreaProps>(childAt(elementChildren(nodes[0]), 2), ChatInputArea);
        expect(inputProps.promptMenuInteractionsEnabled).toBe(false);
    });

    it('keeps the prompt-adjacent wrapper when zero menu rows leave only the custom panel slot', () => {
        // Given: a collapsed menu budget and a caller-provided prompt-adjacent panel.
        const policy = bottomDockPolicy({ columns: 80, rows: 7 });
        const promptAdjacentPanel = (
            <box>
                <text>custom panel</text>
            </box>
        );

        // When: the slash menu would be hidden by policy but the custom panel remains.
        const node = dockNodeForSlice(
            dockSliceWith({ inputMirror: '/', menuState: createSlashCommandMenuState() }),
            policy.menu,
            promptAdjacentPanel,
        );

        // Then: the same column wrapper is present and contains only the custom panel.
        const children = elementChildren(node);
        expect(children.length).toBe(5);
        const panelChildren = dockPromptPanelChildren(node);
        expect(panelChildren.length).toBe(1);
        const customPanelProps = propsFor<{ readonly children?: ReactNode }>(childAt(panelChildren, 0), 'box');
        const customPanelTextProps = propsFor<{ readonly children?: string }>(customPanelProps.children, 'text');
        expect(customPanelTextProps.children).toBe('custom panel');
    });
});

describe('direct prompt-adjacent panel defaults', () => {
    it('preserves panel row counts and footers for direct callers', () => {
        // Given: a direct caller that does not pass dock policy overrides.
        const slashPanel = SlashMenuPanel({
            inputBuffer: '/',
            menuState: createSlashCommandMenuState(),
            workflowNames: [],
        });
        const filePanel = FileAutocompletePanel({ fileAutocomplete: openFileAutocompleteState(12) });

        // When/Then: current row counts and footers remain the default behavior.
        expect(slashChoiceRowCount(slashPanel)).toBe(5);
        expect(overlayFrameProps(slashPanel).footer).toBe(slashFooter);
        expect(fileChoiceRowCount(filePanel)).toBe(8);
        expect(overlayFrameProps(filePanel).footer).toBe(fileFooter);
    });
});

describe('selectChatBottomDockSlice', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not notify when only outputText changes', () => {
        // Given: a selector store built from the dock selector.
        vi.useFakeTimers();
        const store = createChatStore();
        const selectorStore = createChatSelectorStore(store, selectChatBottomDockSlice);
        const listener = vi.fn();
        const dispose = selectorStore.subscribe(listener);
        const before = selectorStore.getSnapshot();

        // When: streaming output publishes without touching dock-relevant state.
        store.emitOutput('token-1\n');
        store.emitOutput('token-2\n');
        vi.advanceTimersByTime(50);

        // Then: outputText changed on the parent store, but the dock selector stayed silent and stable.
        expect(store.getSnapshot().outputText).toBe('token-1\ntoken-2\n');
        expect(listener).not.toHaveBeenCalled();
        expect(selectorStore.getSnapshot()).toBe(before);
        dispose();
    });

    it('notifies when approval changes the live separator state but keeps approval modal out of the input slot', () => {
        // Given: a dock selector snapshot in normal input mode.
        const store = createChatStore();
        const selectorStore = createChatSelectorStore(store, selectChatBottomDockSlice);
        const listener = vi.fn();
        const dispose = selectorStore.subscribe(listener);
        const before = selectorStore.getSnapshot();

        // When: a modal overlay that ChatApp owns opens.
        store.showApproval('bash.run', 'run tests');

        // Then: the dock slice updates only the separator state; approval modal rendering stays outside the dock.
        expect(store.getSnapshot().overlayMode).toBe('approval');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(selectorStore.getSnapshot()).toMatchObject({
            inputMode: before.inputMode,
            separatorState: 'awaiting_input',
        });
        dispose();
    });
});
