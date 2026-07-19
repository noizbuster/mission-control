import { sanitizeTerminalDisplayText, type TranscriptPart } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';

export function emitTranscriptPart(output: ChatOutput, part: TranscriptPart, fallbackText: string): void {
    const writeTranscriptPart = output.writeTranscriptPart;
    if (writeTranscriptPart !== undefined) {
        writeTranscriptPart(part, fallbackText);
        return;
    }
    output.write(sanitizeTerminalDisplayText(fallbackText));
}

export function emitTranscriptFallback(output: ChatOutput, text: string): void {
    const writeTranscriptFallback = output.writeTranscriptFallback;
    if (writeTranscriptFallback !== undefined) {
        writeTranscriptFallback(text);
        return;
    }
    output.write(sanitizeTerminalDisplayText(text));
}
