import type { AgentEvent, AgentSession, AgentSnapshot } from '@mission-control/protocol';

export class SessionEventLog {
    private readonly events: AgentEvent[] = [];

    append(event: AgentEvent): void {
        this.events.push(event);
    }

    getEvents(): AgentEvent[] {
        return [...this.events];
    }

    getSnapshot(session: AgentSession): AgentSnapshot {
        const startedTaskIds = new Set<string>();
        const completedTaskIds = new Set<string>();
        const failedTaskIds = new Set<string>();
        let lastEvent: AgentEvent | undefined;
        let lastMessage: string | undefined;
        let stoppedAt: string | undefined;
        let nativeSidecarStatus: AgentSnapshot['nativeSidecarStatus'] = 'unknown';

        for (const event of this.events) {
            lastEvent = event;
            if (event.message !== undefined) {
                lastMessage = event.message;
            }
            if (event.nativeSidecarStatus !== undefined) {
                nativeSidecarStatus = event.nativeSidecarStatus;
            }
            if (event.type === 'session.stopped') {
                stoppedAt = event.timestamp;
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
            startedAt: session.startedAt,
            ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            runningTaskCount,
            completedTaskCount: completedTaskIds.size,
            failedTaskCount: failedTaskIds.size,
            ...(lastEvent !== undefined ? { lastEvent } : {}),
            ...(lastMessage !== undefined ? { lastMessage } : {}),
            nativeSidecarStatus,
        };
    }
}
