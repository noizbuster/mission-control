import type { AbgGraphSnapshot, AgentEvent, AgentSnapshot } from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';

export interface MemoryStore {
    append(event: AgentEvent): Promise<void>;
    getEvents(sessionId: string): Promise<readonly AgentEvent[]>;
    getSnapshot(sessionId: string): Promise<AgentSnapshot>;
    getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot>;
    getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]>;
    compact(sessionId: string): Promise<void>;
}
