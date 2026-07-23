import type { AbgGraphSnapshot, AgentEvent, AgentSession, AgentSnapshot } from '@mission-control/protocol';
import { deriveAbgGraphSnapshot } from './behavior/graph-state';
import { type AbgTimelineEntry, projectAbgTimeline } from './behavior/timeline';

export class SessionEventLog {
    private readonly events: AgentEvent[] = [];

    append(event: AgentEvent): void {
        this.events.push(event);
    }

    /**
     * Release the live event array in place. The field is `readonly` (forbids
     * reassignment) but in-place truncation via `.length = 0` is allowed.
     * Callers MUST compute any derived snapshot BEFORE calling this, since
     * `getSnapshot`/`getTimeline`/`getGraphSnapshot` scan `this.events`.
     */
    clear(): void {
        this.events.length = 0;
    }

    getEvents(): AgentEvent[] {
        return [...this.events];
    }

    getGraphSnapshot(graphId: string): AbgGraphSnapshot {
        return deriveAbgGraphSnapshot(this.events, graphId);
    }

    getTimeline(): readonly AbgTimelineEntry[] {
        return projectAbgTimeline(this.events);
    }

    getSnapshot(session: AgentSession): AgentSnapshot {
        const startedTaskIds = new Set<string>();
        const completedTaskIds = new Set<string>();
        const failedTaskIds = new Set<string>();
        let lastEvent: AgentEvent | undefined;
        let lastMessage: string | undefined;
        let stoppedAt: string | undefined;
        let nativeSidecarStatus: AgentSnapshot['nativeSidecarStatus'] = 'unknown';
        let modelProviderSelection: AgentSnapshot['modelProviderSelection'] | undefined;

        for (const event of this.events) {
            lastEvent = event;
            if (event.message !== undefined) {
                lastMessage = event.message;
            }
            if (event.nativeSidecarStatus !== undefined) {
                nativeSidecarStatus = event.nativeSidecarStatus;
            }
            if (event.modelProviderSelection !== undefined) {
                modelProviderSelection = event.modelProviderSelection;
            }
            if (event.type === 'session.stopped') {
                stoppedAt = event.timestamp;
            }
            if (event.type === 'run.started' || event.type === 'task.started') {
                stoppedAt = undefined;
            }
            if (event.taskId === undefined) {
                continue;
            }
            if (event.type === 'task.started') {
                startedTaskIds.add(event.taskId);
            }
            if (event.type === 'task.completed') {
                completedTaskIds.add(event.taskId);
            }
            if (event.type === 'task.failed') {
                failedTaskIds.add(event.taskId);
            }
        }

        const finishedTaskIds = new Set([...completedTaskIds, ...failedTaskIds]);
        const runningTaskCount = [...startedTaskIds].filter((taskId) => !finishedTaskIds.has(taskId)).length;

        return {
            sessionId: session.id,
            status: session.status,
            ...(session.awaiting !== undefined ? { awaiting: session.awaiting } : {}),
            startedAt: session.startedAt,
            ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            runningTaskCount,
            completedTaskCount: completedTaskIds.size,
            failedTaskCount: failedTaskIds.size,
            ...(lastEvent !== undefined ? { lastEvent } : {}),
            ...(lastMessage !== undefined ? { lastMessage } : {}),
            nativeSidecarStatus,
            ...(modelProviderSelection !== undefined ? { modelProviderSelection } : {}),
        };
    }
}
