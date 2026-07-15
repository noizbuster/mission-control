/** @jsxImportSource @opentui/solid */

import { type JSX } from 'solid-js';
import { useSolidStoreSelector } from '../../platform/use-solid-store-selector';
import {
    APPROVAL_LEVEL_PICKER_ENTRIES,
    APPROVAL_OPTIONS,
    type ChatStore,
    type ChatStoreOverlayMode,
} from '../../state/chat-store';
import { DialogPrompt } from './dialog-prompt';
import { DialogSelect, type DialogSelectOption } from './dialog-select';

export type DialogContent = {
    readonly element: JSX.Element;
    readonly onClose: () => void;
};

function RenameDialogContent(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    return (
        <DialogPrompt
            title="Rename Session"
            value={snapshot().renameBuffer}
            placeholder="Enter new session name"
            onConfirm={(value) => props.store.submitRename(value)}
        />
    );
}

function ApprovalDialogContent(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const options: readonly DialogSelectOption<string>[] = APPROVAL_OPTIONS.map((opt) => ({
        title: opt.label,
        value: opt.key,
        description: opt.description,
    }));
    return (
        <DialogSelect
            title="Approval Required"
            options={options}
            placeholder="No options"
            onSelect={(option: DialogSelectOption<string>) => {
                props.store.hideApproval();
                props.store.enqueueEvent({ type: 'line', value: option.value });
            }}
        />
    );
}

function LevelPickerDialogContent(props: { store: ChatStore }): JSX.Element {
    const options: readonly DialogSelectOption<string>[] = APPROVAL_LEVEL_PICKER_ENTRIES.map((entry) => ({
        title: entry.label,
        value: entry.id,
        description: entry.desc,
    }));
    return (
        <DialogSelect
            title="Select approval level"
            options={options}
            placeholder="No levels"
            onSelect={(option: DialogSelectOption<string>) => {
                props.store.hideLevelPicker(option.value);
            }}
        />
    );
}

function ModelPickerDialogContent(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const options = (): readonly DialogSelectOption<unknown>[] =>
        snapshot().modelPickerChoices.map((choice) => ({
            title: choice.label,
            value: choice.selection,
        }));
    return (
        <DialogSelect
            title="Select model"
            options={options()}
            placeholder="No models match"
            onSelect={(option: DialogSelectOption<unknown>) => {
                props.store.hideModelPicker(option.value as never);
            }}
        />
    );
}

function SessionPickerDialogContent(props: { store: ChatStore }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (s) => s);
    const options = (): readonly DialogSelectOption<string>[] =>
        snapshot().sessionPickerEntries.map((entry) => ({
            title: entry.label.length > 0 ? entry.label : entry.sessionId,
            value: entry.sessionId,
            ...(entry.updatedAt !== undefined ? { description: entry.updatedAt } : {}),
        }));
    return (
        <DialogSelect
            title="Select session"
            options={options()}
            placeholder="No sessions match"
            onSelect={(option: DialogSelectOption<string>) => {
                props.store.hideSessionPicker(option.value);
            }}
        />
    );
}

export function renderDialogContent(mode: ChatStoreOverlayMode, store: ChatStore): DialogContent {
    switch (mode) {
        case 'rename':
            return {
                element: <RenameDialogContent store={store} />,
                onClose: () => {
                    if (store.getSnapshot().overlayMode === 'rename') store.cancelRename();
                },
            };
        case 'approval':
            return {
                element: <ApprovalDialogContent store={store} />,
                onClose: () => {
                    if (store.getSnapshot().overlayMode === 'approval') store.denyApproval();
                },
            };
        case 'level-picker':
            return {
                element: <LevelPickerDialogContent store={store} />,
                onClose: () => {
                    if (store.getSnapshot().overlayMode === 'level-picker') store.hideLevelPicker(undefined);
                },
            };
        case 'model-picker':
            return {
                element: <ModelPickerDialogContent store={store} />,
                onClose: () => {
                    if (store.getSnapshot().overlayMode === 'model-picker') store.hideModelPicker(undefined);
                },
            };
        case 'session-picker':
            return {
                element: <SessionPickerDialogContent store={store} />,
                onClose: () => {
                    if (store.getSnapshot().overlayMode === 'session-picker') store.hideSessionPicker(undefined);
                },
            };
        default:
            return {
                element: <DialogPrompt title="Unknown" value="" />,
                onClose: () => {},
            };
    }
}
