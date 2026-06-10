import type {
    AgentEvent,
    AgentSession,
    ModelProviderSelection,
    ProviderCredentialSummary,
} from '@mission-control/protocol';
import { isTauri, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { credentialSummary, demoEvents, demoSession, mockReceipt } from './agent-client-demo.js';
import {
    type DesktopApprovalDecisionInput,
    type DesktopCommandReceipt,
    DesktopCommandReceiptSchema,
    type DesktopPromptCommandInput,
    type DesktopRunCommandInput,
} from './desktop-command-schemas.js';
import {
    type DesktopSessionLog,
    type DesktopSessionSnapshot,
    DesktopSessionSnapshotSchema,
    type DesktopSessionSummary,
    DesktopSessionSummaryListSchema,
    parseDesktopSessionLogPayload,
} from './desktop-session-schemas.js';

export type {
    DesktopApprovalDecisionInput,
    DesktopApprovalDecisionState,
    DesktopCommandReceipt,
    DesktopPromptCommandInput,
    DesktopRunCommandInput,
} from './desktop-command-schemas.js';
export { DesktopCommandReceiptSchema } from './desktop-command-schemas.js';
export type {
    DesktopSessionDiagnostic,
    DesktopSessionLog,
    DesktopSessionSnapshot,
    DesktopSessionState,
    DesktopSessionSummary,
} from './desktop-session-schemas.js';
export {
    DESKTOP_SESSION_STATES,
    DesktopSessionDiagnosticSchema,
    DesktopSessionLogSchema,
    DesktopSessionSnapshotSchema,
    DesktopSessionStateSchema,
    DesktopSessionSummaryListSchema,
    DesktopSessionSummarySchema,
    parseDesktopSessionLogPayload,
} from './desktop-session-schemas.js';

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type SaveDesktopProviderCredentialInput = {
    readonly providerID: string;
    readonly apiKey: string;
};

export interface DesktopAgentClient {
    listSessions(): Promise<readonly DesktopSessionSummary[]>;
    readSessionEvents(sessionId: string): Promise<DesktopSessionLog>;
    readSessionSnapshot(sessionId: string): Promise<DesktopSessionSnapshot>;
    submitPrompt(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt>;
    queueFollowUp(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt>;
    steerRun(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt>;
    interruptRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt>;
    resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt>;
    decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt>;
    listProviderCredentials(): Promise<readonly ProviderCredentialSummary[]>;
    saveProviderCredential(input: SaveDesktopProviderCredentialInput): Promise<ProviderCredentialSummary>;
}

export interface MockDesktopAgentClient extends DesktopAgentClient {
    startDemoSession(): Promise<AgentSession>;
    runDemoTask(sessionId: string, modelProviderSelection: ModelProviderSelection): Promise<readonly AgentEvent[]>;
}

export function createTauriDesktopAgentClient(invokeCommand: TauriInvoke = defaultTauriInvoke): DesktopAgentClient {
    let credentialSummaries: readonly ProviderCredentialSummary[] = [];
    return {
        async listSessions(): Promise<readonly DesktopSessionSummary[]> {
            return DesktopSessionSummaryListSchema.parse(await invokeCommand('list_sessions'));
        },
        async readSessionEvents(sessionId: string): Promise<DesktopSessionLog> {
            return parseDesktopSessionLogPayload(await invokeCommand('read_session_events', { sessionId }));
        },
        async readSessionSnapshot(sessionId: string): Promise<DesktopSessionSnapshot> {
            return DesktopSessionSnapshotSchema.parse(await invokeCommand('read_session_snapshot', { sessionId }));
        },
        async submitPrompt(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            return DesktopCommandReceiptSchema.parse(await invokeCommand('submit_prompt', { input }));
        },
        async queueFollowUp(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            return DesktopCommandReceiptSchema.parse(await invokeCommand('queue_follow_up', { input }));
        },
        async steerRun(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            return DesktopCommandReceiptSchema.parse(await invokeCommand('steer_run', { input }));
        },
        async interruptRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
            return DesktopCommandReceiptSchema.parse(await invokeCommand('interrupt_run', { input }));
        },
        async resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
            return DesktopCommandReceiptSchema.parse(await invokeCommand('resume_run', { input }));
        },
        async decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt> {
            return DesktopCommandReceiptSchema.parse(await invokeCommand('decide_approval', { input }));
        },
        async listProviderCredentials(): Promise<readonly ProviderCredentialSummary[]> {
            return credentialSummaries;
        },
        async saveProviderCredential(input: SaveDesktopProviderCredentialInput): Promise<ProviderCredentialSummary> {
            const summary = credentialSummary(input);
            credentialSummaries = [
                ...credentialSummaries.filter((credential) => credential.providerID !== input.providerID),
                summary,
            ];
            return summary;
        },
    };
}

export function createMockDesktopAgentClient(): MockDesktopAgentClient {
    let credentialSummaries: readonly ProviderCredentialSummary[] = [];
    return {
        async listSessions(): Promise<readonly DesktopSessionSummary[]> {
            return [];
        },
        async readSessionEvents(sessionId: string): Promise<DesktopSessionLog> {
            return {
                sessionId,
                state: 'missing',
                contents: '',
                envelopes: [],
                diagnostics: [],
            };
        },
        async readSessionSnapshot(sessionId: string): Promise<DesktopSessionSnapshot> {
            return {
                sessionId,
                state: 'missing',
                eventCount: 0,
                graphIds: [],
                diagnostics: [],
            };
        },
        async submitPrompt(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            return mockReceipt(input.sessionId, 'completed');
        },
        async queueFollowUp(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            return mockReceipt(input.sessionId, 'queued');
        },
        async steerRun(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
            return mockReceipt(input.sessionId, 'completed');
        },
        async interruptRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
            return mockReceipt(input.sessionId, 'interrupted');
        },
        async resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
            return mockReceipt(input.sessionId, 'completed');
        },
        async decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt> {
            return mockReceipt(input.sessionId, input.state === 'approved' ? 'completed' : 'blocked');
        },
        async startDemoSession(): Promise<AgentSession> {
            return demoSession();
        },

        async runDemoTask(
            sessionId: string,
            modelProviderSelection: ModelProviderSelection,
        ): Promise<readonly AgentEvent[]> {
            return demoEvents(sessionId, modelProviderSelection);
        },

        async listProviderCredentials(): Promise<readonly ProviderCredentialSummary[]> {
            return credentialSummaries;
        },

        async saveProviderCredential(input: SaveDesktopProviderCredentialInput): Promise<ProviderCredentialSummary> {
            const summary = credentialSummary(input);
            credentialSummaries = [
                ...credentialSummaries.filter((credential) => credential.providerID !== input.providerID),
                summary,
            ];
            return summary;
        },
    };
}

async function defaultTauriInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!isTauri()) {
        throw new Error('Tauri IPC unavailable');
    }
    return tauriInvoke(command, args);
}
