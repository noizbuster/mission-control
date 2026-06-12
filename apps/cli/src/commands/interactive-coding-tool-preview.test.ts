import type { ToolCall } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { renderToolPreview } from './interactive-coding-tool-preview.js';
import { createBufferedChatOutput } from './run-agent-chat-test-support.js';

describe('interactive coding tool preview', () => {
    it('redacts token-like secrets in raw file.patch and command.run arguments', () => {
        // Given
        const secret = ['sk', 'tool_preview_123'].join('-');
        const output = createBufferedChatOutput();

        // When
        renderToolPreview(
            toolCall('command.run', 'command_preview', {
                command: 'pnpm',
                args: ['exec', 'vitest', 'run', `${secret}.test.ts`],
            }),
            output.output,
        );
        renderToolPreview(
            toolCall('file.patch', 'patch_preview', { patch: addFilePatch('.preview-secret.txt', secret) }),
            output.output,
        );

        // Then
        expect(output.getOutput()).toContain('[REDACTED_CREDENTIAL]');
        expect(output.getOutput()).not.toContain(secret);
    });
});

function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return {
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input),
    };
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}
