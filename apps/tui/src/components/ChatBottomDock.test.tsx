import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatSelectorStore } from '../state/chat-selector-store';
import { createChatStore } from '../state/chat-store';
import { createSlashCommandMenuState } from '../state/interactive-chat-command-menu';
import { createSkillCommandMenuView } from '../state/interactive-chat-command-menu';
import {
    buildBottomStatusBarProps,
    buildTopStatusBarProps,
    chatBottomDockSliceEqual,
    createStableChatBottomDockSelector,
    type ChatBottomDockSlice,
    selectChatBottomDockSlice,
} from './ChatBottomDock';
import { bottomDockPolicy } from './chat-bottom-dock-policy';
import { type StatusBarProps, statusBarLayoutFromPolicy } from './StatusBar';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));
vi.mock('@mission-control/tui/chat', async () => await import('../chat'));
vi.mock('@mission-control/core', () => ({
    resolveUserConfigDir: () => '/tmp/mission-control-test-config',
}));

const statusLayout = statusBarLayoutFromPolicy(bottomDockPolicy({ columns: 120, rows: 24 }));

function readChatBottomDockSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatBottomDock.tsx'), 'utf8');
}

function readChatInputAreaSource(): string {
    return readFileSync(resolve(process.cwd(), 'apps/tui/src/components/ChatInputArea.tsx'), 'utf8');
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
    const start = source.indexOf(startNeedle);
    const end = source.indexOf(endNeedle, start);
    if (start < 0 || end < 0) {
        throw new Error(`missing source slice ${startNeedle}..${endNeedle}`);
    }
    return source.slice(start, end);
}

function baseStatusProps(onCopySessionID: () => void = (): void => {}): StatusBarProps {
    return {
        providerID: 'local',
        modelID: 'local-echo',
        workspaceRoot: '/home/user/mission-control',
        gitBranch: 'main',
        isWorktree: false,
        approvalLevel: 'verbose',
        onCopySessionID,
    };
}

function sliceWith(overrides: Partial<ChatBottomDockSlice>): ChatBottomDockSlice {
    const store = createChatStore();
    return {
        ...selectChatBottomDockSlice(store.getSnapshot()),
        ...overrides,
    };
}

describe('ChatBottomDockBase source topology', () => {
    it('keeps status, prompt panels, input slot, and bottom status in order', () => {
        const source = readChatBottomDockSource();
        const block = sliceBetween(source, 'export function ChatBottomDockBase', 'export function ChatBottomDock(');

        expect(block.indexOf('<TopStatusBar')).toBeLessThan(block.indexOf('renderPromptAdjacentPanels'));
        expect(block.indexOf('renderPromptAdjacentPanels')).toBeLessThan(
            block.indexOf("props.dockSlice.inputMode === 'question'"),
        );
        expect(block.indexOf("props.dockSlice.inputMode === 'question'")).toBeLessThan(block.indexOf('<BottomStatusBar'));
        expect(block).toContain('<QuestionOverlay store={props.store} />');
        expect(block).toContain('<ChatInputArea');
        expect(block).toContain('textareaRef={props.textareaRef}');
        expect(block).toContain('scrollboxRef={props.scrollboxRef}');
        expect(block).toContain('focused={props.inputFocused ?? true}');
        expect(block).toContain('useTerminalDimensions');
        expect(block).toContain('viewportRows={dimensions().height}');
        expect(block).toContain('promptMenuInteractionsEnabled={menuPolicy().rows > 0}');
        expect(readChatInputAreaSource()).toContain('useTuiPromptRef');
    });

    it('derives prompt-adjacent menu visibility from slash, workflow, skill, file, history picker, and menu-row state', () => {
        const source = readChatBottomDockSource();
        const block = sliceBetween(
            source,
            'function renderPromptAdjacentPanels',
            'export function buildTopStatusBarProps',
        );

        expect(block).toContain('dockSlice.historyPicker.open');
        expect(block).toContain('<HistoryPickerPanel');
        expect(block).toContain("dockSlice.inputMirror.startsWith('/')");
        expect(block).toContain("dockSlice.inputMirror.startsWith('#')");
        expect(block).toContain("dockSlice.inputMirror.startsWith('$')");
        expect(block).toContain('dockSlice.fileAutocomplete.open');
        expect(block).toContain('menuPolicy.rows > 0');
        expect(block).toContain('<SlashMenuPanel');
        expect(block).toContain('skillNames={dockSlice.skillNames}');
        expect(block).toContain('<FileAutocompletePanel');
        expect(block).toContain('{promptAdjacentPanel ?? null}');
    });

    it('uses injected viewportRows for PgUp/PgDn scroll and does not read process stdout rows', () => {
        const source = readChatInputAreaSource();
        const stdoutRowsToken = ['process', 'stdout', 'rows'].join('.');

        expect(source).toContain('viewportRows');
        expect(source).toContain('halfPageScrollDelta(props.viewportRows)');
        expect(source).not.toContain(stdoutRowsToken);
    });

    it('pins input placeholder phrases for slash, workflow, and skill prefixes', () => {
        const source = readChatInputAreaSource();
        expect(source).toContain('/ for commands');
        expect(source).toContain('# for workflows');
        expect(source).toContain('$ for skills');
    });

    it('uses a stable dock slice selector so stream output publishes do not thrash the dock', () => {
        const source = readChatBottomDockSource();
        expect(source).toContain('createStableChatBottomDockSelector');
        expect(source).toContain('useSolidStoreSelector(props.store, selectDockSlice)');
    });
});

describe('stable chat bottom dock slice', () => {
    it('treats two slices with identical fields as equal', () => {
        const left = sliceWith({ generating: true, agentStatusText: 'Working…' });
        const right: ChatBottomDockSlice = { ...left };
        expect(chatBottomDockSliceEqual(left, right)).toBe(true);
    });

    it('detects generating and agent status changes', () => {
        const idle = sliceWith({ generating: false, agentStatusText: '' });
        const busy: ChatBottomDockSlice = { ...idle, generating: true, agentStatusText: 'Working…' };
        expect(chatBottomDockSliceEqual(idle, busy)).toBe(false);
    });

    it('returns the previous slice reference when only outputText changed', () => {
        const store = createChatStore();
        const select = createStableChatBottomDockSelector();
        store.setGenerating(true);
        const first = select(store.getSnapshot());
        store.replaceOutputText(`${store.getOutput()}Assistant: hello world`);
        const second = select(store.getSnapshot());
        expect(second).toBe(first);
    });

    it('returns a new slice when generating flips', () => {
        const store = createChatStore();
        const select = createStableChatBottomDockSelector();
        const first = select(store.getSnapshot());
        store.setGenerating(true);
        const second = select(store.getSnapshot());
        expect(second).not.toBe(first);
        expect(second.generating).toBe(true);
    });
});

describe('ChatBottomDockBase status props', () => {
    it('threads live provider, variant, and context fields into the top status bar props', () => {
        const dockSlice = sliceWith({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
            contextTokensUsed: 12345,
            contextTokensMax: 200000,
        });

        const props = buildTopStatusBarProps({ statusBarProps: baseStatusProps(), statusLayout, dockSlice });

        expect(props).toMatchObject({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
            contextTokensUsed: 12345,
            contextTokensMax: 200000,
            statusLayout,
        });
    });

    it('threads session and approval fields into the bottom status bar props', () => {
        const onCopySessionID = vi.fn();
        const dockSlice = sliceWith({ sessionId: 'session_123', approvalLevel: 'safe' });

        const props = buildBottomStatusBarProps({
            statusBarProps: baseStatusProps(onCopySessionID),
            statusLayout,
            dockSlice,
        });

        expect(props).toMatchObject({
            sessionID: 'session_123',
            approvalLevel: 'safe',
            onCopySessionID,
            statusLayout,
        });
    });

    it('omits optional top and bottom status bars when caller status props are absent', () => {
        const dockSlice = sliceWith({});

        expect(buildTopStatusBarProps({ statusBarProps: undefined, statusLayout, dockSlice })).toBeUndefined();
        expect(buildBottomStatusBarProps({ statusBarProps: undefined, statusLayout, dockSlice })).toBeUndefined();
    });
});

describe('ChatBottomDockBase menu policy contract', () => {
    it('keeps dock-owned slash/workflow and file autocomplete menus bounded by policy rows', () => {
        const policy = bottomDockPolicy({ columns: 120, rows: 24 });
        const source = readChatBottomDockSource();
        const block = sliceBetween(
            source,
            'function renderPromptAdjacentPanels',
            'export function buildTopStatusBarProps',
        );

        expect(policy.menu.rows).toBe(8);
        expect(block).toContain('maxVisibleRows={menuPolicy.rows}');
        expect(block).toContain('showFooter={menuPolicy.showPanelFooter}');
    });

    it('disables dock-owned menu interactions when policy has zero menu rows', () => {
        const policy = bottomDockPolicy({ columns: 80, rows: 7 });
        const source = readChatBottomDockSource();
        const block = sliceBetween(source, 'export function ChatBottomDockBase', 'export function ChatBottomDock(');

        expect(policy.menu.rows).toBe(0);
        expect(block).toContain('promptMenuInteractionsEnabled={menuPolicy().rows > 0}');
    });
});

describe('selectChatBottomDockSlice', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('selects normal input mode with model, session, approval, token, and idle separator state', () => {
        const store = createChatStore();
        store.setModelSelection({ providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-high' });
        store.setSessionId('session_123');
        store.setApprovalLevel('safe');
        store.setContextTokensUsed(12345);
        store.setContextTokensMax(200000);

        expect(selectChatBottomDockSlice(store.getSnapshot())).toMatchObject({
            inputMode: 'input',
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
            contextTokensUsed: 12345,
            contextTokensMax: 200000,
            sessionId: 'session_123',
            approvalLevel: 'safe',
            separatorState: 'idle',
        });
    });

    it('selects question mode and awaiting-input separator only for question overlays', () => {
        const store = createChatStore();
        void store.showQuestion('Pick one', ['Yes', 'No'], { header: 'Question' });

        expect(selectChatBottomDockSlice(store.getSnapshot())).toMatchObject({
            inputMode: 'question',
            separatorState: 'awaiting_input',
        });
    });

    it('keeps modal overlays in input mode while exposing the awaiting-input separator state', () => {
        const store = createChatStore();
        store.showApproval('bash.run', 'run tests');

        expect(selectChatBottomDockSlice(store.getSnapshot())).toMatchObject({
            inputMode: 'input',
            separatorState: 'awaiting_input',
        });
    });

    it('does not notify when only outputText changes', () => {
        vi.useFakeTimers();
        const store = createChatStore();
        const selectorStore = createChatSelectorStore(store, selectChatBottomDockSlice);
        const listener = vi.fn();
        const dispose = selectorStore.subscribe(listener);
        const before = selectorStore.getSnapshot();

        store.emitOutput('token-1\n');
        store.emitOutput('token-2\n');
        vi.advanceTimersByTime(50);

        expect(store.getSnapshot().outputText).toBe('token-1\ntoken-2\n');
        expect(listener).not.toHaveBeenCalled();
        expect(selectorStore.getSnapshot()).toBe(before);
        dispose();
    });

    it('notifies when approval changes the live separator state but keeps approval modal out of the input slot', () => {
        const store = createChatStore();
        const selectorStore = createChatSelectorStore(store, selectChatBottomDockSlice);
        const listener = vi.fn();
        const dispose = selectorStore.subscribe(listener);
        const before = selectorStore.getSnapshot();

        store.showApproval('bash.run', 'run tests');

        expect(store.getSnapshot().overlayMode).toBe('approval');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(selectorStore.getSnapshot()).toMatchObject({
            inputMode: before.inputMode,
            separatorState: 'awaiting_input',
        });
        dispose();
    });

    it('carries slash menu, workflow names, skill names, and file autocomplete state into the dock slice', () => {
        const store = createChatStore();
        const menuState = createSlashCommandMenuState();
        const fileAutocomplete = {
            open: true,
            prefix: 'file',
            selectedIndex: 0,
            matches: [{ name: 'file-1.ts', isDirectory: false }],
        };
        const snapshot = {
            ...store.getSnapshot(),
            inputMirror: '/',
            menuState,
            workflowNames: ['default', 'planner', 'executer'],
            skillNames: ['planner', 'git-master'],
            fileAutocomplete,
        };

        expect(selectChatBottomDockSlice(snapshot)).toMatchObject({
            inputMirror: '/',
            menuState,
            workflowNames: ['default', 'planner', 'executer'],
            skillNames: ['planner', 'git-master'],
            fileAutocomplete,
        });
    });

    it('opens skill menu for $pl with skillNames so $planner is the selected choice', () => {
        const store = createChatStore();
        store.setSkillNames(['planner', 'git-master']);
        const slice = selectChatBottomDockSlice({
            ...store.getSnapshot(),
            inputMirror: '$pl',
        });
        const view = createSkillCommandMenuView('$pl', slice.menuState, 5, slice.skillNames);

        expect(slice.inputMirror.startsWith('$')).toBe(true);
        expect(view.open).toBe(true);
        expect(view.visibleChoices.map((choice) => choice.id)).toContain('$planner');
        expect(view.visibleChoices[view.selectedIndex - view.startIndex]?.id).toBe('$planner');
    });
});
