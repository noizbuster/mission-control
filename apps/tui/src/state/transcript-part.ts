export type TranscriptPartStatus =
    | 'pending'
    | 'running'
    | 'streaming'
    | 'completed'
    | 'failed'
    | 'denied'
    | 'cancelled'
    | 'interrupted'
    | 'background'
    | 'informational'
    | 'historical';

export type TranscriptPartDetails = {
    readonly title?: string;
    readonly detail?: string;
    readonly status?: TranscriptPartStatus;
    readonly error?: string;
};

type TranscriptPartBase = {
    readonly id: string;
    readonly text: string;
};

export type UserTranscriptPart = TranscriptPartBase & {
    readonly type: 'user';
};

export type AssistantTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'assistant';
        readonly messageId?: string;
        readonly requestId?: string;
    };

export type ReasoningTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'reasoning';
        readonly messageId?: string;
        readonly requestId?: string;
    };

type ToolTranscriptPartDetails = TranscriptPartDetails & {
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly messageId?: string;
    readonly output?: string;
    readonly appliedFiles?: readonly string[];
};

export type InlineToolTranscriptPart = TranscriptPartBase &
    ToolTranscriptPartDetails & {
        readonly type: 'inline-tool';
    };

export type BlockToolTranscriptPart = TranscriptPartBase &
    ToolTranscriptPartDetails & {
        readonly type: 'block-tool';
    };

export type DiffTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'diff';
        readonly filePath?: string;
        readonly toolCallId?: string;
        readonly messageId?: string;
    };

export type CodeTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'code';
        readonly filePath?: string;
        readonly language?: string;
    };

export type CommandTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'command';
        readonly command?: string;
        readonly exitCode?: number;
        readonly toolCallId?: string;
        readonly toolName?: string;
        readonly messageId?: string;
    };

export type SubagentTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'subagent';
        readonly agentName?: string;
        readonly sessionId?: string;
        readonly toolCallId?: string;
        readonly messageId?: string;
    };

export type StatusTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'status';
    };

export type EventTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'event';
        readonly eventId?: string;
        readonly eventType?: string;
        readonly timestamp?: string;
    };

export type ErrorTranscriptPart = TranscriptPartBase &
    TranscriptPartDetails & {
        readonly type: 'error';
        readonly code?: string;
    };

export type LegacyTranscriptPart = TranscriptPartBase & {
    readonly type: 'legacy';
};

export type TranscriptPart =
    | UserTranscriptPart
    | AssistantTranscriptPart
    | ReasoningTranscriptPart
    | InlineToolTranscriptPart
    | BlockToolTranscriptPart
    | DiffTranscriptPart
    | CodeTranscriptPart
    | CommandTranscriptPart
    | SubagentTranscriptPart
    | StatusTranscriptPart
    | EventTranscriptPart
    | ErrorTranscriptPart
    | LegacyTranscriptPart;

export function upsertTranscriptPart(
    parts: readonly TranscriptPart[],
    part: TranscriptPart,
): readonly TranscriptPart[] {
    const existingIndex = parts.findIndex((existing) => existing.id === part.id);
    if (existingIndex === -1) {
        return [...parts, part];
    }
    return parts.map((existing, index) => (index === existingIndex ? part : existing));
}
