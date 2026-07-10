/** @jsxImportSource @opentui/solid */

import { type TextareaRenderable, TextAttributes } from '@opentui/core';
import { useBindings } from '@opentui/keymap/solid';
import { createEffect, createSignal, onMount, Show, type JSX } from 'solid-js';
import { useSpinnerFrame } from '../spinner.js';
import { useTuiTheme } from '../../platform/providers/route-dialog-theme-context.js';
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

function confirm(
    props: DialogPromptProps,
    textarea: TextareaRenderable,
): void {
    if (props.busy) return;
    props.onConfirm?.(textarea.plainText);
}

export function DialogPrompt(props: DialogPromptProps): JSX.Element {
    const dialog = useDialog();
    const theme = useTuiTheme();
    const spinner = useSpinnerFrame();
    const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable | undefined>();
    let textarea: TextareaRenderable | undefined;

    useBindings(() => ({
        ...(textareaTarget() !== undefined ? { target: textareaTarget } : {}),
        enabled: textareaTarget() !== undefined && props.busy !== true,
        priority: 1,
        bindings: [
            {
                key: 'return',
                desc: 'Submit dialog prompt',
                group: 'Dialog',
                cmd: () => {
                    if (textarea === undefined) return;
                    confirm(props, textarea);
                },
            },
        ],
    }));

    onMount(() => {
        dialog.setSize('medium');
        setTimeout(() => {
            if (textarea === undefined) return;
            if (textarea.isDestroyed) return;
            if (props.busy) return;
            textarea.focus();
        }, 1);
        if (textarea !== undefined) {
            textarea.gotoLineEnd();
        }
    });

    createEffect(() => {
        if (textarea === undefined) return;
        if (textarea.isDestroyed) return;
        const traits = props.busy ? { suspend: true, status: 'BUSY' } : {};
        textarea.traits = traits;
        if (props.busy) {
            textarea.blur();
            return;
        }
        textarea.focus();
    });

    const textColor = (): string => (props.busy ? '#888888' : '#ffffff');
    const cursorColor = (): string => (props.busy ? '#444444' : '#ffffff');

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
                <textarea
                    height={3}
                    ref={(val: TextareaRenderable) => {
                        textarea = val;
                        setTextareaTarget(val);
                    }}
                    {...(props.value !== undefined ? { initialValue: props.value } : {})}
                    placeholder={props.placeholder ?? 'Enter text'}
                    placeholderColor="#666666"
                    textColor={textColor()}
                    focusedTextColor={textColor()}
                    cursorColor={cursorColor()}
                />
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
