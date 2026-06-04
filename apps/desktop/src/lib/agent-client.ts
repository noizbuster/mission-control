import type {
    AgentEvent,
    AgentSession,
    ModelProviderSelection,
    ProviderCredentialSummary,
} from '@mission-control/protocol';

export type SaveDesktopProviderCredentialInput = {
    readonly providerID: string;
    readonly apiKey: string;
};

export interface DesktopAgentClient {
    startDemoSession(): Promise<AgentSession>;
    runDemoTask(sessionId: string, modelProviderSelection: ModelProviderSelection): Promise<readonly AgentEvent[]>;
    listProviderCredentials(): Promise<readonly ProviderCredentialSummary[]>;
    saveProviderCredential(input: SaveDesktopProviderCredentialInput): Promise<ProviderCredentialSummary>;
}

export function createMockDesktopAgentClient(): DesktopAgentClient {
    let credentialSummaries: readonly ProviderCredentialSummary[] = [];
    return {
        async startDemoSession(): Promise<AgentSession> {
            return {
                id: `session_${Date.now()}`,
                status: 'running',
                startedAt: new Date().toISOString(),
            };
        },

        async runDemoTask(
            sessionId: string,
            modelProviderSelection: ModelProviderSelection,
        ): Promise<readonly AgentEvent[]> {
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
                    abg: {
                        graphId,
                    },
                },
                {
                    type: 'model.call.started',
                    timestamp,
                    sessionId,
                    message: 'desktop demo model call started',
                    modelProviderSelection,
                    abg: {
                        graphId,
                        nodeId,
                        model,
                    },
                },
                {
                    type: 'node.started',
                    timestamp,
                    sessionId,
                    message: 'desktop demo node started',
                    modelProviderSelection,
                    abg: {
                        graphId,
                        nodeId,
                        signalType: 'started',
                        model,
                    },
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
                    type: 'model.call.completed',
                    timestamp,
                    sessionId,
                    message: 'desktop demo model call completed',
                    modelProviderSelection,
                    abg: {
                        graphId,
                        nodeId,
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
                    abg: {
                        graphId,
                    },
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
        },

        async listProviderCredentials(): Promise<readonly ProviderCredentialSummary[]> {
            return credentialSummaries;
        },

        async saveProviderCredential(input: SaveDesktopProviderCredentialInput): Promise<ProviderCredentialSummary> {
            const summary = {
                providerID: input.providerID,
                authenticated: true,
                maskedCredential: maskCredential(input.apiKey),
            } satisfies ProviderCredentialSummary;
            credentialSummaries = [
                ...credentialSummaries.filter((credential) => credential.providerID !== input.providerID),
                summary,
            ];
            return summary;
        },
    };
}

function maskCredential(apiKey: string): string {
    if (apiKey.length <= 8) {
        return '********';
    }
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}
