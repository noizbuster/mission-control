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
                    type: 'task.progress',
                    timestamp,
                    sessionId,
                    taskId: 'task_desktop_demo',
                    progress: 0.5,
                    message: 'desktop demo task in progress',
                    nativeSidecarStatus: 'mock',
                    modelProviderSelection,
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
