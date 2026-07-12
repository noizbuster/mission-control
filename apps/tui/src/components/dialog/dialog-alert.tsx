/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core';
import { useBindings } from '@opentui/keymap/solid';
import { type JSX } from 'solid-js';
import { type DialogContext, useDialog } from './dialog.js';

export type DialogAlertProps = {
    readonly title: string;
    readonly message: string;
    readonly onConfirm?: () => void;
};

export function DialogAlert(props: DialogAlertProps): JSX.Element {
    const dialog = useDialog();

    useBindings(() => ({
        bindings: [
            {
                key: 'return',
                desc: 'Confirm alert',
                group: 'Dialog',
                cmd: () => {
                    props.onConfirm?.();
                    dialog.clear();
                },
            },
        ],
    }));

    return (
        <box paddingLeft={2} paddingRight={2} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
                <text attributes={TextAttributes.BOLD} fg="#ffffff">
                    {props.title}
                </text>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui <text> has no role concept; click-to-close is a dialog UX pattern */}
                <text fg="#888888" onMouseUp={() => dialog.clear()}>
                    esc
                </text>
            </box>
            <box paddingBottom={1}>
                <text fg="#888888">{props.message}</text>
            </box>
            <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; button click is a dialog UX pattern */}
                <box
                    paddingLeft={3}
                    paddingRight={3}
                    backgroundColor="#00ffff"
                    onMouseUp={() => {
                        props.onConfirm?.();
                        dialog.clear();
                    }}
                >
                    <text fg="#000000">ok</text>
                </box>
            </box>
        </box>
    );
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string): Promise<void> => {
    return new Promise<void>((resolve) => {
        dialog.replace(
            <DialogAlert title={title} message={message} onConfirm={() => resolve()} />,
            () => resolve(),
        );
    });
};
