import { redactCredentialText } from '@mission-control/core';
import type { ChatOutput } from './interactive-chat-io';
import { emitTranscriptFallback } from './interactive-transcript-emission';

const GRAPH_RENDER_DIAGNOSTIC_CODE_POINT = /[\p{Cc}\p{Cf}]/gu;

function escapeGraphRenderDiagnostic(message: string): string {
    return message.replace(GRAPH_RENDER_DIAGNOSTIC_CODE_POINT, (character) => {
        const firstCodeUnit = character.charCodeAt(0);
        const codePoint =
            character.length === 1
                ? firstCodeUnit
                : (firstCodeUnit - 0xd800) * 0x400 + character.charCodeAt(1) - 0xdc00 + 0x10000;
        return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
    });
}

export function reportGraphRenderFailure(output: ChatOutput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const redactedMessage = redactCredentialText(message);
    const escapedMessage = escapeGraphRenderDiagnostic(redactedMessage);
    process.stderr.write(`Interactive graph render failed: ${escapedMessage}\n`);
    try {
        emitTranscriptFallback(output, `Error: ${redactedMessage}\n`);
    } catch (writeError: unknown) {
        const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
        const redactedWriteMessage = redactCredentialText(writeMessage);
        const escapedWriteMessage = escapeGraphRenderDiagnostic(redactedWriteMessage);
        process.stderr.write(`Interactive graph render error write failed: ${escapedWriteMessage}\n`);
    }
}
