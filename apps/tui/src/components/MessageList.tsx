/** @jsxImportSource @opentui/solid */

import { For, type JSX } from 'solid-js';

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

export function MessageList({ messages }: MessageListProps): JSX.Element {
    return (
        <box flexDirection="column">
            <For each={messages}>
                {(message) => (
                    <text>
                        {messagePrefix(message.role)}
                        {message.text}
                    </text>
                )}
            </For>
        </box>
    );
}
