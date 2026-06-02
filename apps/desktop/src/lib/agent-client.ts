import type { AgentEvent, AgentSession } from '@mission-control/protocol';

export interface DesktopAgentClient {
    startDemoSession(): Promise<AgentSession>;
    runDemoTask(sessionId: string): Promise<readonly AgentEvent[]>;
}

export function createMockDesktopAgentClient(): DesktopAgentClient {
    return {
        async startDemoSession(): Promise<AgentSession> {
            return {
                id: `session_${Date.now()}`,
                status: 'running',
                startedAt: new Date().toISOString(),
            };
        },

        async runDemoTask(sessionId: string): Promise<readonly AgentEvent[]> {
            const timestamp = new Date().toISOString();
            return [
                {
                    type: 'session.started',
                    timestamp,
                    sessionId,
                    message: 'desktop demo session started',
                    nativeSidecarStatus: 'mock',
                },
                {
                    type: 'task.started',
                    timestamp,
                    sessionId,
                    taskId: 'task_desktop_demo',
                    message: 'desktop demo task started',
                    nativeSidecarStatus: 'mock',
                },
                {
                    type: 'task.progress',
                    timestamp,
                    sessionId,
                    taskId: 'task_desktop_demo',
                    progress: 0.5,
                    message: 'desktop demo task in progress',
                    nativeSidecarStatus: 'mock',
                },
                {
                    type: 'task.completed',
                    timestamp,
                    sessionId,
                    taskId: 'task_desktop_demo',
                    message: 'completed by mock sidecar',
                    nativeSidecarStatus: 'mock',
                },
            ];
        },
    };
}
