import type { AssistantTranscriptPart, TranscriptPart, TranscriptPartStatus } from './transcript-part';

/** Success statuses that may collapse into Element B chips for past turns. */
const SUCCESS_TOOL_STATUSES = new Set<TranscriptPartStatus>([
    'completed',
    'informational',
    'historical',
    'background',
]);

const HIDEABLE_TOOL_PART_TYPES = new Set<TranscriptPart['type']>([
    'inline-tool',
    'block-tool',
    'command',
    'subagent',
    'diff',
]);

function isSuccessfulToolStatus(status: TranscriptPartStatus | undefined): boolean {
    return status !== undefined && SUCCESS_TOOL_STATUSES.has(status);
}

/** Attribution key used for active-assistant tracking and footer binding. */
export function attributionKeyForAssistantPart(part: AssistantTranscriptPart): string {
    return part.messageId ?? part.requestId ?? part.id;
}

/**
 * Hide past successful tool/diff satellites that belong to a non-active assistant turn.
 * Failed / pending / unattributed parts always stay visible.
 */
export function shouldHideToolPart(
    part: TranscriptPart,
    activeAssistantMessageId: string | undefined,
): boolean {
    if (!HIDEABLE_TOOL_PART_TYPES.has(part.type)) {
        return false;
    }
    if (!('status' in part) || !isSuccessfulToolStatus(part.status)) {
        return false;
    }
    const messageId = 'messageId' in part ? part.messageId : undefined;
    if (messageId === undefined || messageId.length === 0) {
        return false;
    }
    return messageId !== activeAssistantMessageId;
}

/** Test helper: filter parts with the same hide rule used by row-level skip. */
export function getVisibleTranscriptParts(
    parts: readonly TranscriptPart[],
    activeAssistantMessageId: string | undefined,
): readonly TranscriptPart[] {
    return parts.filter((part) => !shouldHideToolPart(part, activeAssistantMessageId));
}

/** Last assistant part wins; reasoning and other types never contribute. */
export function activeAssistantMessageIdFromParts(
    parts: readonly TranscriptPart[],
): string | undefined {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part?.type === 'assistant') {
            return attributionKeyForAssistantPart(part);
        }
    }
    return undefined;
}
