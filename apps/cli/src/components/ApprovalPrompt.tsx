/** @jsxImportSource @opentui/react */
import type React from 'react';
import { toOpenTuiAttributes } from '../platform/opentui-types.js';

export type ApprovalOption = {
    readonly key: string;
    readonly label: string;
    readonly description: string;
};

export type ApprovalPromptProps = {
    readonly toolName: string;
    readonly toolArguments?: string;
    readonly options: readonly ApprovalOption[];
    readonly message?: string;
};

const MAX_ARGS_LENGTH = 72;

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}

export function ApprovalPrompt({ toolName, toolArguments, options, message }: ApprovalPromptProps): React.ReactNode {
    return (
        <box flexDirection="column" paddingX={1}>
            {message !== undefined ? <text {...toOpenTuiAttributes({ dimColor: true })}>{message}</text> : null}
            <box flexDirection="row">
                <text {...toOpenTuiAttributes({ bold: true })}>Tool:</text>
                <text> {truncate(toolName, MAX_ARGS_LENGTH)}</text>
            </box>
            {toolArguments !== undefined ? (
                <box flexDirection="row">
                    <text {...toOpenTuiAttributes({ bold: true })}>Args:</text>
                    <text> {truncate(toolArguments, MAX_ARGS_LENGTH)}</text>
                </box>
            ) : null}
            <box flexDirection="column" marginTop={1}>
                {options.map((option) => (
                    <box key={option.key} flexDirection="row">
                        <text {...toOpenTuiAttributes({ bold: true })}>[{option.key}]</text>
                        <text> {option.label} - </text>
                        <text {...toOpenTuiAttributes({ dimColor: true })}>{option.description}</text>
                    </box>
                ))}
            </box>
        </box>
    );
}
