import type { AgentEvent } from '../packages/protocol/src/index.js';

export const codingAgentSmokeSelection = { providerID: 'local', modelID: 'local-echo' } as const;

export type SmokeApprovalStore = {
    readonly append: (event: AgentEvent) => Promise<void>;
    readonly getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
    readonly close: () => Promise<void>;
};

export type SmokeApprovalDependencies = {
    readonly openStore: (input: {
        readonly dataDir: string;
        readonly sessionId: string;
        readonly now: () => string;
        readonly createEventId: (_event: AgentEvent, sequence: number) => string;
    }) => Promise<SmokeApprovalStore>;
    readonly settleApproval: (
        input: {
            readonly sessionId: string;
            readonly approvalId: string;
            readonly state: 'approved';
            readonly reason: string;
        },
        options: {
            readonly store: SmokeApprovalStore;
            readonly sessionId: string;
            readonly workspaceRoot: string;
            readonly modelProviderSelection: typeof codingAgentSmokeSelection;
            readonly now: () => string;
        },
    ) => Promise<'completed' | 'blocked' | 'failed' | 'idle'>;
};

export function createSmokeApprovalEventId(_event: AgentEvent, sequence: number): string {
    return `approval_event_${sequence}`;
}

export function fixedCodingAgentSmokeNow(): string {
    return '2026-06-13T00:00:00.000Z';
}

export function approvalIdForToolCall(toolCallId: string): string {
    return `approval_${requestIdForToolCall(toolCallId)}`;
}

export function requestIdForToolCall(toolCallId: string): string {
    return `permission_${toolCallId}`;
}
