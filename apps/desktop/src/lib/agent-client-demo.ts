import type {
    AgentEvent,
    AgentSession,
    ModelProviderSelection,
    ProviderCredentialSummary,
} from '@mission-control/protocol';
import type { DesktopCommandReceipt, SaveDesktopProviderCredentialInput } from './agent-client.js';

export function demoSession(): AgentSession {
    return {
        id: `session_${Date.now()}`,
        status: 'running',
        startedAt: new Date().toISOString(),
    };
}

export function demoEvents(sessionId: string, modelProviderSelection: ModelProviderSelection): readonly AgentEvent[] {
    const timestamp = new Date().toISOString();
    const graphId = 'desktop-demo-graph';
    const nodeId = 'desktop-answer';
    const model = {
        ...modelProviderSelection,
        variantID: 'default',
    };
    return [
        {
            type: 'session.started',
            timestamp,
            sessionId,
            message: 'desktop demo session started',
            nativeSidecarStatus: 'mock',
            modelProviderSelection,
        },
        {
            type: 'task.started',
            timestamp,
            sessionId,
            taskId: 'task_desktop_demo',
            message: 'desktop demo task started',
            nativeSidecarStatus: 'mock',
            modelProviderSelection,
        },
        {
            type: 'graph.started',
            timestamp,
            sessionId,
            message: 'desktop demo graph started',
            nativeSidecarStatus: 'mock',
            modelProviderSelection,
            abg: { graphId },
        },
        {
            type: 'node.completed',
            timestamp,
            sessionId,
            message: 'desktop demo node completed',
            modelProviderSelection,
            abg: {
                graphId,
                nodeId,
                signalType: 'success',
                model,
            },
        },
        {
            type: 'graph.completed',
            timestamp,
            sessionId,
            message: 'desktop demo graph completed',
            nativeSidecarStatus: 'mock',
            modelProviderSelection,
            abg: { graphId },
        },
        {
            type: 'task.completed',
            timestamp,
            sessionId,
            taskId: 'task_desktop_demo',
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
            modelProviderSelection,
        },
    ];
}

export function credentialSummary(input: SaveDesktopProviderCredentialInput): ProviderCredentialSummary {
    return {
        providerID: input.providerID,
        authenticated: true,
        maskedCredential: maskCredential(input.apiKey),
    };
}

export function mockReceipt(sessionId: string, status: DesktopCommandReceipt['status']): DesktopCommandReceipt {
    return {
        sessionId,
        status,
        eventsWritten: 0,
    };
}

function maskCredential(apiKey: string): string {
    if (apiKey.length <= 8) {
        return '********';
    }
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}
