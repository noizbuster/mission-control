import type {
    AgentEvent,
    AgentSnapshot,
    ApprovalRecord,
    ApprovalSubject,
    ProtocolError,
    RunCoordinatorCommand,
    RunCoordinatorState,
    ToolResult,
} from '@mission-control/protocol';
import type { ToolOutcomeStatus } from '../session-replay-types.js';
import type { JsonlSessionEventStoreErrorCode } from './jsonl-errors.js';

export type SessionIndexSessionRecord = {
    readonly kind: 'session';
    readonly sessionId: string;
    readonly status: AgentSnapshot['status'];
    readonly startedAt: string;
    readonly stoppedAt?: string | undefined;
    readonly eventCount: number;
    readonly lastSequence?: number | undefined;
    readonly lastEventId?: string | undefined;
    readonly lastEventType?: AgentEvent['type'] | undefined;
    readonly updatedAt: string;
    readonly sourceFilePath: string;
};

export type SessionIndexRunRecord = {
    readonly kind: 'run';
    readonly sessionId: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly timestamp: string;
    readonly eventType: AgentEvent['type'];
    readonly command?: RunCoordinatorCommand | undefined;
    readonly state?: RunCoordinatorState | undefined;
    readonly runId?: string | undefined;
    readonly inputId?: string | undefined;
    readonly providerTurnId?: string | undefined;
    readonly reason?: string | undefined;
    readonly errorCode?: ProtocolError['code'] | undefined;
};

export type SessionIndexApprovalRecord = {
    readonly kind: 'approval';
    readonly sessionId: string;
    readonly approvalId: string;
    readonly eventId: string;
    readonly state: ApprovalRecord['state'];
    readonly subject: ApprovalSubject;
    readonly requestedAt: string;
    readonly decidedAt?: string | undefined;
    readonly updatedAt: string;
};

export type SessionIndexToolRecord = {
    readonly kind: 'tool';
    readonly sessionId: string;
    readonly toolId: string;
    readonly status: ToolOutcomeStatus;
    readonly startedAt?: string | undefined;
    readonly completedAt?: string | undefined;
    readonly failedAt?: string | undefined;
    readonly lastMessage?: string | undefined;
    readonly result?: ToolResult | undefined;
    readonly appliedFiles?: readonly string[] | undefined;
};

export type SessionIndexProviderFailureRecord = {
    readonly kind: 'provider_failure';
    readonly sessionId: string;
    readonly eventId: string;
    readonly timestamp: string;
    readonly requestId: string;
    readonly providerTurnId?: string | undefined;
    readonly error: ProtocolError;
};

export type SessionIndexRecord =
    | SessionIndexSessionRecord
    | SessionIndexRunRecord
    | SessionIndexApprovalRecord
    | SessionIndexToolRecord
    | SessionIndexProviderFailureRecord;

export type SessionIndexDiagnostic = {
    readonly kind: 'corrupt_jsonl';
    readonly sessionId: string;
    readonly filePath: string;
    readonly code: JsonlSessionEventStoreErrorCode | 'unknown';
    readonly message: string;
    readonly lineNumber?: number | undefined;
};

export type SessionIndexRebuildResult = {
    readonly sessionId: string;
    readonly indexedRecords: number;
    readonly diagnostics: readonly SessionIndexDiagnostic[];
};

export interface SessionIndexStore {
    replaceSessionIndex(input: {
        readonly sessionId: string;
        readonly records: readonly SessionIndexRecord[];
        readonly diagnostics: readonly SessionIndexDiagnostic[];
    }): Promise<void>;
    listSessions(): Promise<readonly SessionIndexSessionRecord[]>;
    getSession(sessionId: string): Promise<SessionIndexSessionRecord | null>;
    getRuns(sessionId: string): Promise<readonly SessionIndexRunRecord[]>;
    getApprovals(sessionId: string): Promise<readonly SessionIndexApprovalRecord[]>;
    getTools(sessionId: string): Promise<readonly SessionIndexToolRecord[]>;
    getProviderFailures(sessionId: string): Promise<readonly SessionIndexProviderFailureRecord[]>;
    getDiagnostics(sessionId: string): Promise<readonly SessionIndexDiagnostic[]>;
}
