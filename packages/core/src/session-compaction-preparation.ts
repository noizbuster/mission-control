import type { AgentEventEnvelope, AgentMessage } from '@mission-control/protocol';
import {
    projectApprovalContinuationMessages,
    projectApprovalContinuationTranscript,
    type SequencedAgentMessage,
} from './session-continuation-projection.js';
import type { JsonlSessionReplayPrefixProjection } from './session-replay-types.js';

export type SessionCompactionPreparation =
    | {
          readonly status: 'denied';
          readonly reason: 'corrupt' | 'too_small';
          readonly message: string;
      }
    | {
          readonly status: 'ready';
          readonly boundaryEntryId: string;
          readonly boundarySequence: number;
          readonly firstKeptEntryId: string;
          readonly firstKeptSequence: number;
          readonly visibleMessages: readonly AgentMessage[];
          readonly rawTranscript: readonly SequencedAgentMessage[];
          readonly summaryMessages: readonly AgentMessage[];
      };

export function prepareSessionCompaction(input: {
    readonly sessionId: string;
    readonly replay: JsonlSessionReplayPrefixProjection;
    readonly keepRecentMessageCount?: number;
    readonly minVisibleMessages?: number;
}): SessionCompactionPreparation {
    if (input.replay.diagnostics.length > 0 || input.replay.projection.sessionTree.diagnostics.length > 0) {
        return {
            status: 'denied',
            reason: 'corrupt',
            message: `Cannot compact corrupt session: ${input.sessionId}`,
        };
    }
    const rawTranscript = projectApprovalContinuationTranscript(input.replay.projection.events, input.sessionId);
    const visibleMessages = projectApprovalContinuationMessages(input.replay.projection.events, input.sessionId);
    const visibleMessageCount = visibleMessages.filter((message) => message.role !== 'system').length;
    const minVisibleMessages = input.minVisibleMessages ?? 4;
    if (visibleMessageCount < minVisibleMessages || rawTranscript.length === 0) {
        return {
            status: 'denied',
            reason: 'too_small',
            message: `Nothing to compact (session has ${visibleMessageCount} visible messages)`,
        };
    }
    const keepRecentMessageCount = Math.max(1, input.keepRecentMessageCount ?? 4);
    const keptMessages = rawTranscript.slice(-keepRecentMessageCount);
    const firstKept = keptMessages.at(0);
    const boundary = rawTranscript.at(-1);
    if (firstKept === undefined || boundary === undefined) {
        return {
            status: 'denied',
            reason: 'too_small',
            message: 'Nothing to compact (session has no replayable transcript)',
        };
    }

    const summaryMessages = rawTranscript
        .filter((entry) => entry.sourceSequence < firstKept.sourceSequence)
        .map((entry) => entry.message)
        .filter((message) => message.role !== 'tool');
    if (summaryMessages.length === 0) {
        return {
            status: 'denied',
            reason: 'too_small',
            message: 'Nothing to compact (all replayable messages are in the kept tail)',
        };
    }

    return {
        status: 'ready',
        boundaryEntryId: entryIdAtSequence(input.replay.projection.envelopes, boundary.sourceSequence),
        boundarySequence: boundary.sourceSequence,
        firstKeptEntryId: entryIdAtSequence(input.replay.projection.envelopes, firstKept.sourceSequence),
        firstKeptSequence: firstKept.sourceSequence,
        visibleMessages,
        rawTranscript,
        summaryMessages,
    };
}

function entryIdAtSequence(envelopes: readonly AgentEventEnvelope[], sequence: number): string {
    return envelopes[sequence]?.eventId ?? `sequence_${sequence}`;
}
