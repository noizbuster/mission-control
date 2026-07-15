/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core';
import { useBindings } from '@opentui/keymap/solid';
import { For, type JSX } from 'solid-js';
import { createStore } from 'solid-js/store';
import { type DialogContext, useDialog } from './dialog';

export type DialogConfirmProps = {
    readonly title: string;
    readonly message: string;
    readonly onConfirm?: () => void;
    readonly onCancel?: () => void;
    readonly label?: string;
};

export type DialogConfirmResult = boolean | undefined;

export function DialogConfirm(props: DialogConfirmProps): JSX.Element {
    const dialog = useDialog();
    const [store, setStore] = createStore<{ active: 'confirm' | 'cancel' }>({
        active: 'confirm',
    });

    useBindings(() => ({
        bindings: [
            {
                key: 'return',
                desc: 'Confirm dialog selection',
                group: 'Dialog',
                cmd: () => {
                    if (store.active === 'confirm') props.onConfirm?.();
                    if (store.active === 'cancel') props.onCancel?.();
                    dialog.clear();
                },
            },
            {
                key: 'left',
                desc: 'Previous dialog option',
                group: 'Dialog',
                cmd: () => {
                    setStore('active', store.active === 'confirm' ? 'cancel' : 'confirm');
                },
            },
            {
                key: 'right',
                desc: 'Next dialog option',
                group: 'Dialog',
                cmd: () => {
                    setStore('active', store.active === 'confirm' ? 'cancel' : 'confirm');
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
                <For each={['cancel', 'confirm'] as const}>
                    {(key) => (
                        // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; button click is a dialog UX pattern
                        <box
                            paddingLeft={1}
                            paddingRight={1}
                            {...(key === store.active ? { backgroundColor: '#00ffff' } : {})}
                            onMouseUp={() => {
                                if (key === 'confirm') props.onConfirm?.();
                                if (key === 'cancel') props.onCancel?.();
                                dialog.clear();
                            }}
                        >
                            <text fg={key === store.active ? '#000000' : '#888888'}>
                                {key === 'cancel' ? (props.label ?? key) : key}
                            </text>
                        </box>
                    )}
                </For>
            </box>
        </box>
    );
}

DialogConfirm.show = (
    dialog: DialogContext,
    title: string,
    message: string,
    label?: string,
): Promise<DialogConfirmResult> => {
    return new Promise<DialogConfirmResult>((resolve) => {
        dialog.replace(
            <DialogConfirm
                title={title}
                message={message}
                onConfirm={() => resolve(true)}
                onCancel={() => resolve(false)}
                {...(label !== undefined ? { label } : {})}
            />,
            () => resolve(undefined),
        );
    });
};
