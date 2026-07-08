/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';

export type TextInputProps = {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onSubmit: (value: string) => void;
    readonly placeholder?: string;
    readonly prefix?: string;
};

const defaultPrefix = '> ';

export function TextInput({ value, placeholder, prefix = defaultPrefix }: TextInputProps): JSX.Element {
    const showPlaceholder = value.length === 0 && placeholder !== undefined;
    return (
        <box flexDirection="row">
            <text>{prefix}</text>
            <text {...(showPlaceholder ? { dim: true } : {})}>{showPlaceholder ? placeholder : value}</text>
        </box>
    );
}
