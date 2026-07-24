import type { ProtocolError } from '@mission-control/protocol';

export interface AgentJobRecoveryReport {
    readonly recovered: number;
    readonly cancelled: number;
    readonly preserved: number;
}

export interface StartSubagentWaitInput {
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly agentId?: string;
    readonly mode: 'sync' | 'detached';
}

export interface ResolveSubagentWaitInput {
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly output: string;
    readonly failure?: ProtocolError;
}
