/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createEffect, createSignal, type JSX, onMount, Show } from 'solid-js';
import { useTuiTheme } from '../../platform/providers/route-dialog-theme-context.js';
import { printableCharFromKey } from '../overlay-key-input.js';
import { useSpinnerFrame } from '../spinner.js';
import { type DialogContext, useDialog } from './dialog.js';

export type DialogPromptProps = {
    readonly title: string;
    readonly description?: JSX.Element;
    readonly placeholder?: string;
    readonly value?: string;
    readonly busy?: boolean;
    readonly busyText?: string;
    readonly onConfirm?: (value: string) => void;
    readonly onCancel?: () => void;
};

export function DialogPrompt(props: DialogPromptProps): JSX.Element {
    const dialog = useDialog();
    const theme = useTuiTheme();
    const spinner = useSpinnerFrame();
    const [buffer, setBuffer] = createSignal(props.value ?? '');

    useKeyboard((key) => {
        if (props.busy) return;
        if (key.name === 'return') {
            key.preventDefault();
            props.onConfirm?.(buffer());
            return;
        }
        if (key.name === 'escape') {
            key.preventDefault();
            dialog.clear();
            return;
        }
        if (key.name === 'backspace') {
            key.preventDefault();
            setBuffer((prev) => prev.slice(0, -1));
            return;
        }
        const ch = printableCharFromKey(key);
        if (ch !== undefined) {
            key.preventDefault();
            setBuffer((prev) => prev + ch);
        }
    });

    onMount(() => {
        dialog.setSize('medium');
    });

    const textColor = (): string => (props.busy ? '#888888' : '#ffffff');

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
            <box gap={1}>
                {props.description}
                <box flexDirection="row">
                    <text fg="#00ffff">{'>'}</text>
                    <text fg={textColor()}>{buffer()}</text>
                    <Show when={buffer().length === 0 && props.placeholder !== undefined}>
                        <text fg="#666666">{props.placeholder}</text>
                    </Show>
                    <text bg="#ffffff" fg="#000000">
                        {'\u2588'}
                    </text>
                </box>
                <Show when={props.busy}>
                    <box flexDirection="row" gap={1}>
                        <text fg="#888888">{spinner.glyph()}</text>
                        <text fg="#888888">{props.busyText ?? 'Working...'}</text>
                    </box>
                </Show>
            </box>
            <box paddingBottom={1} gap={1} flexDirection="row">
                <Show when={props.busy !== true} fallback={<text fg="#888888">processing...</text>}>
                    <text fg="#ffffff">
                        {'\u23ce'} <span style={{ fg: '#888888' }}>submit</span>
                    </text>
                </Show>
            </box>
        </box>
    );
}

DialogPrompt.show = (
    dialog: DialogContext,
    title: string,
    options?: Omit<DialogPromptProps, 'title'>,
): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
        dialog.replace(
            <DialogPrompt
                title={title}
                {...(options ?? {})}
                onConfirm={(value: string) => resolve(value)}
                onCancel={() => resolve(null)}
            />,
            () => resolve(null),
        );
    });
};
