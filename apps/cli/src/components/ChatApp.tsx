/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Banner } from './Banner.js';
import { ChatTranscript } from './ChatTranscript.js';
import { ChatInputArea } from './ChatInputArea.js';
import { SlashMenuPanel } from './SlashMenuPanel.js';
import { FileAutocompletePanel } from './FileAutocompletePanel.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';
import {
    ApprovalOverlay,
    QuestionOverlay,
    ModelPickerOverlay,
    LevelPickerOverlay,
    RenameOverlay,
} from './OverlayPanels.js';
import type { ChatStore } from '../commands/chat-store.js';
import { parseMessageBlocks } from '../commands/chat-blocks.js';

const SPINNER_FRAMES = '\u280b\u2819\u2839\u2838\u2834\u2826\u2827\u2807';

function AgentSpinner({ text }: { readonly text: string }): React.ReactNode {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
        return (): void => clearInterval(timer);
    }, []);
    const ch = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0] ?? '';
    return (
        <box marginTop={1}>
            <text fg="#00ffff">{`${ch} ${text}`}</text>
        </box>
    );
}

export type ChatAppProps = {
    readonly store: ChatStore;
    readonly textareaRef: React.RefObject<TextareaRenderable | null>;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly statusBarProps?: StatusBarProps;
};

export function ChatApp({
    store,
    textareaRef,
    scrollboxRef,
    statusBarProps,
}: ChatAppProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    useKeyboard((key) => {
        const isCtrlC = key.ctrl && key.name === 'c';
        if (textareaRef.current?.focused && !isCtrlC) {
            return;
        }
        if (isCtrlC) {
            store.sendInterrupt('ctrl-c');
            return;
        }
    });

    const messageBlocks = parseMessageBlocks(snapshot.outputText);
    const overlayActive = snapshot.overlayMode !== 'none';

    const transcript = (
        <ChatTranscript
            blocks={messageBlocks}
            scrollboxRef={scrollboxRef}
            generating={snapshot.generating}
            toolOutputExpanded={snapshot.toolOutputExpanded}
        />
    );

    if (snapshot.overlayMode === 'approval') {
        return (
            <box flexDirection="column">
                {transcript}
                <ApprovalOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'question') {
        return (
            <box flexDirection="column">
                {transcript}
                <QuestionOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'model-picker') {
        return (
            <box flexDirection="column">
                {transcript}
                <ModelPickerOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'level-picker') {
        return (
            <box flexDirection="column">
                {transcript}
                <LevelPickerOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'rename') {
        return (
            <box flexDirection="column">
                {transcript}
                <RenameOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'abg') {
        return (
            <box flexDirection="column">
                <text fg="#ff0000">ABG overlay not available in this context</text>
            </box>
        );
    }

    if (snapshot.overlayMode === 'diff-viewer') {
        return (
            <box flexDirection="column">
                <text fg="#ffff00">Diff viewer not available in this context</text>
            </box>
        );
    }

    const showSlashMenu = snapshot.inputMirror.startsWith('/');
    const showWorkflowMenu = snapshot.inputMirror.startsWith('#');
    const showFileAutocomplete = !showSlashMenu && !showWorkflowMenu && snapshot.fileAutocomplete.open;

    return (
        <box flexDirection="column">
            {statusBarProps !== undefined ? (
                <Banner statusBarProps={statusBarProps} />
            ) : (
                <Banner />
            )}
            {transcript}
            {snapshot.agentStatusText.length > 0 ? (
                <AgentSpinner text={snapshot.agentStatusText} />
            ) : snapshot.generating ? (
                <box marginTop={1}>
                    <text fg="#ffff00">{'\u25cf Thinking...'}</text>
                </box>
            ) : null}
            {showSlashMenu || showWorkflowMenu ? (
                <SlashMenuPanel
                    inputBuffer={snapshot.inputMirror}
                    menuState={snapshot.menuState}
                    workflowNames={snapshot.workflowNames}
                />
            ) : null}
            {showFileAutocomplete ? (
                <FileAutocompletePanel fileAutocomplete={snapshot.fileAutocomplete} />
            ) : null}
            <ChatInputArea
                store={store}
                textareaRef={textareaRef}
                scrollboxRef={scrollboxRef}
                focused={!overlayActive}
            />
            {statusBarProps !== undefined ? (
                <box marginTop={1}>
                    <StatusBar
                        {...statusBarProps}
                        {...(snapshot.approvalLevel !== undefined
                            ? { approvalLevel: snapshot.approvalLevel }
                            : {})}
                    />
                </box>
            ) : null}
        </box>
    );
}
