import { redactCredentialText } from '@mission-control/core/redaction';
import type { TranscriptPart, TranscriptPartDetails } from './transcript-part';

export function sanitizeTerminalDisplayText(text: string): string {
    return escapeTerminalDisplayControls(redactCredentialText(text));
}

export function sanitizeTranscriptPartForDisplay(part: TranscriptPart): TranscriptPart {
    const text = sanitizeTerminalDisplayText(part.text);
    const details = sanitizeTranscriptDetails(part);
    switch (part.type) {
        case 'user':
        case 'assistant':
        case 'reasoning':
        case 'status':
        case 'legacy':
            return { ...part, text, ...details };
        case 'inline-tool':
        case 'block-tool':
            return {
                ...part,
                text,
                ...details,
                ...(part.toolName === undefined ? {} : { toolName: sanitizeTerminalDisplayText(part.toolName) }),
                ...(part.output === undefined ? {} : { output: sanitizeTerminalDisplayText(part.output) }),
                ...(part.appliedFiles === undefined
                    ? {}
                    : { appliedFiles: part.appliedFiles.map(sanitizeTerminalDisplayText) }),
            };
        case 'diff':
            return {
                ...part,
                text,
                ...details,
                ...(part.filePath === undefined ? {} : { filePath: sanitizeTerminalDisplayText(part.filePath) }),
            };
        case 'code':
            return {
                ...part,
                text,
                ...details,
                ...(part.filePath === undefined ? {} : { filePath: sanitizeTerminalDisplayText(part.filePath) }),
                ...(part.language === undefined ? {} : { language: sanitizeTerminalDisplayText(part.language) }),
            };
        case 'command':
            return {
                ...part,
                text,
                ...details,
                ...(part.command === undefined ? {} : { command: sanitizeTerminalDisplayText(part.command) }),
            };
        case 'subagent':
            return {
                ...part,
                text,
                ...details,
                ...(part.agentName === undefined ? {} : { agentName: sanitizeTerminalDisplayText(part.agentName) }),
                ...(part.sessionId === undefined ? {} : { sessionId: sanitizeTerminalDisplayText(part.sessionId) }),
            };
        case 'event':
            return {
                ...part,
                text,
                ...details,
                ...(part.eventType === undefined ? {} : { eventType: sanitizeTerminalDisplayText(part.eventType) }),
                ...(part.timestamp === undefined ? {} : { timestamp: sanitizeTerminalDisplayText(part.timestamp) }),
            };
        case 'error':
            return {
                ...part,
                text,
                ...details,
                ...(part.code === undefined ? {} : { code: sanitizeTerminalDisplayText(part.code) }),
            };
    }
}

function sanitizeTranscriptDetails(part: TranscriptPartDetails & { readonly text: string }): TranscriptPartDetails {
    return {
        ...(part.title === undefined ? {} : { title: sanitizeTerminalDisplayText(part.title) }),
        ...(part.detail === undefined ? {} : { detail: sanitizeTerminalDisplayText(part.detail) }),
        ...(part.error === undefined ? {} : { error: sanitizeTerminalDisplayText(part.error) }),
    };
}

export function escapeTerminalDisplayControls(text: string): string {
    return Array.from(text, (character) => {
        const codePoint = character.charCodeAt(0);
        if (!isForbiddenTerminalDisplayCodePoint(codePoint)) return character;
        return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
    }).join('');
}

function isForbiddenTerminalDisplayCodePoint(codePoint: number): boolean {
    return (
        (codePoint <= 0x1f && codePoint !== 0x0a) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
}
