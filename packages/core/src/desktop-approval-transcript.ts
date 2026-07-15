import type { AgentEvent, AgentMessage } from '@mission-control/protocol';
import { prepareSessionCompaction, type SessionCompactionPreparation } from './session-compaction-preparation';
import {
    hasPendingDesktopApprovals,
    projectApprovalContinuationMessages,
    projectApprovalContinuationTranscript,
    type SequencedAgentMessage,
} from './session-continuation-projection';

export {
    hasPendingDesktopApprovals,
    prepareSessionCompaction,
    projectApprovalContinuationMessages,
    projectApprovalContinuationTranscript,
};
export function projectDesktopApprovalContinuationMessages(
    events: readonly AgentEvent[],
    sessionId: string,
): readonly AgentMessage[] {
    return projectApprovalContinuationMessages(events, sessionId);
}

export type { SequencedAgentMessage, SessionCompactionPreparation };
