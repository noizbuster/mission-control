/** @jsxImportSource @opentui/react */

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

export function MessageList({ messages }: MessageListProps): React.ReactNode {
    return (
        <box flexDirection="column">
            {messages.map((message) => (
                <text key={`${message.role}-${message.text.slice(0, 16)}`}>
                    {messagePrefix(message.role)}
                    {message.text}
                </text>
            ))}
        </box>
    );
}
