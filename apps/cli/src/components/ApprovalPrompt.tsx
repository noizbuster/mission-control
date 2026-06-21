import { Box, Text } from 'ink';
import type React from 'react';

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

export function ApprovalPrompt({ toolName, toolArguments, options, message }: ApprovalPromptProps): React.ReactElement {
    return (
        <Box flexDirection="column" paddingX={1}>
            {message !== undefined ? <Text dimColor>{message}</Text> : null}
            <Text>
                <Text bold>Tool:</Text> {truncate(toolName, MAX_ARGS_LENGTH)}
            </Text>
            {toolArguments !== undefined ? (
                <Text>
                    <Text bold>Args:</Text> {truncate(toolArguments, MAX_ARGS_LENGTH)}
                </Text>
            ) : null}
            <Box flexDirection="column" marginTop={1}>
                {options.map((option) => (
                    <Text key={option.key}>
                        <Text bold>[{option.key}]</Text> {option.label}
                        {' - '}
                        <Text dimColor>{option.description}</Text>
                    </Text>
                ))}
            </Box>
        </Box>
    );
}
