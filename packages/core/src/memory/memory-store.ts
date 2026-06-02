import type { AgentEvent, AgentSnapshot } from '@mission-control/protocol';

export interface MemoryStore {
    append(event: AgentEvent): Promise<void>;
    getSnapshot(sessionId: string): Promise<AgentSnapshot>;
    compact(sessionId: string): Promise<void>;
}
