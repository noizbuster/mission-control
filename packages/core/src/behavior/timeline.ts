import type { AbgNodeModelOptions, AgentEvent } from '@mission-control/protocol';

export type AbgTimelineEntry = {
    readonly timestamp: string;
    readonly type: AgentEvent['type'];
    readonly graphId: string;
    readonly nodeId?: string;
    readonly message?: string;
    readonly model?: AbgNodeModelOptions;
};

export function projectAbgTimeline(events: readonly AgentEvent[]): readonly AbgTimelineEntry[] {
    return events.flatMap((event) => {
        const graphId = event.abg?.graphId;
        if (graphId === undefined) {
            return [];
        }
        return [
            {
                timestamp: event.timestamp,
                type: event.type,
                graphId,
                ...(event.abg?.nodeId !== undefined ? { nodeId: event.abg.nodeId } : {}),
                ...(event.message !== undefined ? { message: event.message } : {}),
                ...(event.abg?.model !== undefined ? { model: event.abg.model } : {}),
            },
        ];
    });
}
