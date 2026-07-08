import { Children, type ElementType, isValidElement, type ReactNode } from 'react';
import { expect } from 'vitest';
import { createChatStore } from '../commands/chat-store.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
} from '../commands/chat-test-support.js';
import type { FileAutocompleteState } from '../commands/interactive-chat-file-autocomplete.js';
import { ChatBottomDockBase, type ChatBottomDockSlice, selectChatBottomDockSlice } from './ChatBottomDock.js';
import { type BottomDockMenuPolicy, bottomDockPolicy } from './chat-bottom-dock-policy.js';
import { OverlayFrame, type OverlayFrameProps } from './OverlayFrame.js';
import { type StatusBarProps, statusBarLayoutFromPolicy } from './StatusBar.js';

export const statusLayout = statusBarLayoutFromPolicy(bottomDockPolicy({ columns: 120, rows: 24 }));
export const slashFooter = 'Up/Down to navigate, Enter to select, Esc to close';
export const fileFooter = 'Tab/Enter to complete, Up/Down to navigate, Esc to close';

export function elementChildren(node: ReactNode): readonly ReactNode[] {
    if (!isValidElement<{ readonly children?: ReactNode }>(node)) {
        throw new Error('expected a React element with children');
    }
    return Children.toArray(node.props.children);
}

export function childAt(children: readonly ReactNode[], index: number): ReactNode {
    const child = children.at(index);
    if (child === undefined) {
        throw new Error(`missing child at index ${index}`);
    }
    return child;
}

export function propsFor<TProps>(node: ReactNode, type: ElementType<TProps> | string): TProps {
    if (!isValidElement<TProps>(node)) {
        throw new Error('expected a React element');
    }
    expect(node.type).toBe(type);
    return node.props;
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
    menuPolicy: BottomDockMenuPolicy,
    promptAdjacentPanel?: ReactNode,
    viewportColumns?: number,
): ReactNode {
    const store = createChatStore();
    return ChatBottomDockBase({
        store,
        textareaRef: asTextareaRef(createRecordingTextarea()),
        scrollboxRef: asScrollboxRef(createRecordingScrollbox()),
        statusBarProps: baseStatusProps(),
        statusLayout,
        menuPolicy,
        ...(viewportColumns !== undefined ? { viewportColumns } : {}),
        ...(promptAdjacentPanel !== undefined ? { promptAdjacentPanel } : {}),
        dockSlice,
    });
}

export function dockPromptPanelChildren(node: ReactNode): readonly ReactNode[] {
    const children = elementChildren(node);
    const panelProps = propsFor<{ readonly children?: ReactNode }>(childAt(children, 1), 'box');
    return Children.toArray(panelProps.children);
}

export function firstDockPanelProps<TProps>(node: ReactNode, type: ElementType<TProps>): TProps {
    const panelChildren = dockPromptPanelChildren(node);
    expect(panelChildren.length).toBe(1);
    return propsFor<TProps>(childAt(panelChildren, 0), type);
}

export function overlayFrameProps(node: ReactNode): OverlayFrameProps {
    return propsFor<OverlayFrameProps>(node, OverlayFrame);
}

export function slashChoiceRowCount(node: ReactNode): number {
    return Math.max(0, Children.toArray(overlayFrameProps(node).children).length - 1);
}

export function fileChoiceRowCount(node: ReactNode): number {
    return Children.toArray(overlayFrameProps(node).children).length;
}

export function expectMenuPolicyProps(
    props: { readonly maxVisibleRows?: number; readonly showFooter?: boolean },
    policy: BottomDockMenuPolicy,
): void {
    expect([props.maxVisibleRows, props.showFooter]).toEqual([policy.rows, policy.showPanelFooter]);
}
