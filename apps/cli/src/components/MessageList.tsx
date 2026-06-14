import { Box, Text } from 'ink';

export type ChatMessage = {
    readonly text: string;
    readonly role: 'user' | 'assistant' | 'system';
};

export type MessageListProps = {
    readonly messages: readonly ChatMessage[];
};

function messagePrefix(role: ChatMessage['role']): string {
    if (role === 'user') return '> ';
    return '';
}

export function MessageList({ messages }: MessageListProps): React.JSX.Element {
    return (
        <Box flexDirection="column">
            {messages.map((message, index) => (
                <Text key={index}>
                    {messagePrefix(message.role)}
                    {message.text}
                </Text>
            ))}
        </Box>
    );
}
