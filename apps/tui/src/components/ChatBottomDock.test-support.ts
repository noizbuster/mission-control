import type { JSX } from 'solid-js';
import { expect } from 'vitest';
import { createChatStore } from '../state/chat-store';
import type { FileAutocompleteState } from '../state/interactive-chat-file-autocomplete';
import { ChatBottomDockBase, type ChatBottomDockSlice, selectChatBottomDockSlice } from './ChatBottomDock';
import { type BottomDockMenuPolicy, bottomDockPolicy } from './chat-bottom-dock-policy';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
} from './chat-test-support';
import { OverlayFrame, type OverlayFrameProps } from './OverlayFrame';
import { type StatusBarProps, statusBarLayoutFromPolicy } from './StatusBar';

export const statusLayout = statusBarLayoutFromPolicy(bottomDockPolicy({ columns: 120, rows: 24 }));
export const slashFooter = 'Up/Down to navigate, Enter to select, Esc to close';
export const fileFooter = 'Tab/Enter to complete, Up/Down to navigate, Esc to close';

type TestElement = {
    readonly type: unknown;
    readonly props: { readonly children?: JSX.Element } & Record<string, unknown>;
};

export function elementChildNodes(node: unknown): readonly unknown[] {
    return childrenArray(testElement(node).props.children);
}

export function childAt(children: readonly unknown[], index: number): unknown {
    const child = children.at(index);
    if (child === undefined) {
        throw new Error(`missing child at index ${index}`);
    }
    return child;
}

export function propsFor<TProps>(node: unknown, type: unknown): TProps {
    const element = testElement(node);
    expect(element.type).toBe(type);
    return element.props as TProps;
}

export function baseStatusProps(onCopySessionID: () => void = (): void => {}): StatusBarProps {
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

export function openFileAutocompleteState(total: number): FileAutocompleteState {
    return {
        open: true,
        prefix: 'file',
        selectedIndex: 0,
        matches: Array.from({ length: total }, (_value, index) => ({
            name: `file-${index + 1}.ts`,
            isDirectory: false,
        })),
    };
}

export function dockSliceWith(overrides: Partial<ChatBottomDockSlice>): ChatBottomDockSlice {
    const store = createChatStore();
    return {
        ...selectChatBottomDockSlice(store.getSnapshot()),
        ...overrides,
    };
}

export function dockNodeForSlice(
    dockSlice: ChatBottomDockSlice,
    _menuPolicy: BottomDockMenuPolicy,
    promptAdjacentPanel?: JSX.Element,
): unknown {
    const store = createChatStore();
    return ChatBottomDockBase({
        store,
        textareaRef: asTextareaRef(createRecordingTextarea()),
        scrollboxRef: asScrollboxRef(createRecordingScrollbox()),
        statusBarProps: baseStatusProps(),
        ...(promptAdjacentPanel !== undefined ? { promptAdjacentPanel } : {}),
        dockSlice,
    });
}

export function dockPromptPanelNodes(node: unknown): readonly unknown[] {
    const children = elementChildNodes(node);
    const panelProps = propsFor<{ readonly children?: JSX.Element }>(childAt(children, 1), 'box');
    return childrenArray(panelProps.children);
}

export function firstDockPanelProps<TProps>(node: unknown, type: unknown): TProps {
    const panelNodes = dockPromptPanelNodes(node);
    expect(panelNodes.length).toBe(1);
    return propsFor<TProps>(childAt(panelNodes, 0), type);
}

export function overlayFrameProps(node: unknown): OverlayFrameProps {
    return propsFor<OverlayFrameProps>(node, OverlayFrame);
}

export function slashChoiceRowCount(node: unknown): number {
    return Math.max(0, childrenArray(overlayFrameProps(node).children).length - 1);
}

export function fileChoiceRowCount(node: unknown): number {
    return childrenArray(overlayFrameProps(node).children).length;
}

export function expectMenuPolicyProps(
    props: { readonly maxVisibleRows?: number; readonly showFooter?: boolean },
    policy: BottomDockMenuPolicy,
): void {
    expect([props.maxVisibleRows, props.showFooter]).toEqual([policy.rows, policy.showPanelFooter]);
}

function testElement(node: unknown): TestElement {
    if (!isTestElement(node)) {
        throw new Error('expected a Solid test element');
    }
    return node;
}

function childrenArray(children: JSX.Element | undefined): readonly unknown[] {
    if (children === undefined || children === null || typeof children === 'boolean') return [];
    return Array.isArray(children) ? children : [children];
}

function isTestElement(value: unknown): value is TestElement {
    // biome-ignore lint/complexity/useLiteralKeys: Record<string, unknown> requires bracket access per noPropertyAccessFromIndexSignature
    return isRecord(value) && 'type' in value && isRecord(value['props']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
