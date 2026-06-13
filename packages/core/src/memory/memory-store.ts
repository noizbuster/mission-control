import type { AbgGraphSnapshot, AgentEvent, AgentSnapshot, ModelProviderSelection } from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';

export type SessionCompactionRecordInput = {
    readonly sessionId: string;
    readonly timestamp: string;
    readonly message: string;
    readonly summary: string;
    readonly boundaryEntryId: string;
    readonly firstKeptEntryId: string;
    readonly boundarySequence?: number;
    readonly firstKeptSequence?: number;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly nativeSidecarStatus?: AgentEvent['nativeSidecarStatus'];
};

export interface MemoryStore {
    append(event: AgentEvent): Promise<void>;
    getEvents(sessionId: string): Promise<readonly AgentEvent[]>;
    getSnapshot(sessionId: string): Promise<AgentSnapshot>;
    getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot>;
    getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]>;
    compact(input: SessionCompactionRecordInput): Promise<AgentEvent>;
}
