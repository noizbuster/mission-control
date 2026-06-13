import { type AgentEvent, AgentEventSchema } from '@mission-control/protocol';
import type { SessionCompactionRecordInput } from './memory-store.js';
import { sanitizeCompactionSummary } from './session-compaction-summary.js';

export function createSessionCompactionEvent(input: SessionCompactionRecordInput): AgentEvent {
    const summary = sanitizeCompactionSummary(input.summary);
    return AgentEventSchema.parse({
        type: 'session.compacted',
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        message: input.message,
        sessionTree: {
            kind: 'compaction',
            boundaryEntryId: input.boundaryEntryId,
            firstKeptEntryId: input.firstKeptEntryId,
            ...(input.boundarySequence !== undefined ? { boundarySequence: input.boundarySequence } : {}),
            ...(input.firstKeptSequence !== undefined ? { firstKeptSequence: input.firstKeptSequence } : {}),
            summary,
        },
        ...(input.modelProviderSelection !== undefined ? { modelProviderSelection: input.modelProviderSelection } : {}),
        ...(input.nativeSidecarStatus !== undefined ? { nativeSidecarStatus: input.nativeSidecarStatus } : {}),
    });
}
