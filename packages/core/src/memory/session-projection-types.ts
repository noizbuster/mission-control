import type {
    AgentEvent,
    AgentSnapshot,
    ApprovalRecord,
    ApprovalSubject,
    ProtocolError,
    RunCoordinatorCommand,
    RunCoordinatorState,
    SessionAwaitingDetails,
    ToolResult,
} from '@mission-control/protocol';
import type { ToolOutcomeStatus } from '../session-replay-types';
import type { JsonlSessionEventStoreErrorCode } from './jsonl-errors';

export type SessionProjectionSessionRecord = {
    readonly kind: 'session';
    readonly sessionId: string;
    readonly status: AgentSnapshot['status'];
    readonly awaiting?: SessionAwaitingDetails | undefined;
    readonly startedAt: string;
    readonly stoppedAt?: string | undefined;
    readonly eventCount: number;
    readonly lastSequence?: number | undefined;
    readonly lastEventId?: string | undefined;
    readonly lastEventType?: AgentEvent['type'] | undefined;
    readonly updatedAt: string;
    readonly sourcePath: string;
    readonly abortMarker?: {
        readonly completedAt: string;
        readonly operationId: string;
        readonly requestId: string;
    };
};

export type SessionProjectionRunRecord = {
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

export type SessionProjectionApprovalRecord = {
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

export type SessionProjectionToolRecord = {
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

export type SessionProjectionProviderFailureRecord = {
    readonly kind: 'provider_failure';
    readonly sessionId: string;
    readonly eventId: string;
    readonly timestamp: string;
    readonly requestId: string;
    readonly providerTurnId?: string | undefined;
    readonly error: ProtocolError;
};

export type SessionProjectionRecord =
    | SessionProjectionSessionRecord
    | SessionProjectionRunRecord
    | SessionProjectionApprovalRecord
    | SessionProjectionToolRecord
    | SessionProjectionProviderFailureRecord;

export type SessionProjectionDiagnostic = {
    readonly kind: 'corrupt_jsonl';
    readonly sessionId: string;
    readonly filePath: string;
    readonly code: JsonlSessionEventStoreErrorCode | 'unknown';
    readonly message: string;
    readonly lineNumber?: number | undefined;
};

export type SessionProjectionRebuildResult = {
    readonly sessionId: string;
    readonly projectedRecords: number;
    readonly diagnostics: readonly SessionProjectionDiagnostic[];
};
