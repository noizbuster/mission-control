import type {
    AbgGraphSnapshot,
    AgentEvent,
    AgentEventEnvelope,
    AgentSnapshot,
    ApprovalRecord,
    ApprovalSubject,
    ProtocolError,
    ToolResult,
} from '@mission-control/protocol';
import type { AbgTimelineEntry } from './behavior/timeline.js';

export type SessionBranchNode = {
    readonly eventId: string;
    readonly sequence: number;
    readonly parentEventId?: string;
    readonly childEventIds: readonly string[];
    readonly eventType: AgentEvent['type'];
    readonly timestamp: string;
    readonly message?: string;
};

export type SessionBranchTree = {
    readonly sessionId: string;
    readonly activeLeafId?: string;
    readonly nodes: readonly SessionBranchNode[];
};

export type SessionBranchSummary = {
    readonly leafEventId: string;
    readonly eventIds: readonly string[];
    readonly eventCount: number;
    readonly lastMessage?: string;
};

export type ApprovalProjection = ApprovalRecord & {
    readonly eventId: string;
    readonly updatedAt: string;
};

export type ToolOutcomeStatus = 'started' | 'completed' | 'failed';

export type ToolOutcomeProjection = {
    readonly toolId: string;
    readonly status: ToolOutcomeStatus;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly failedAt?: string;
    readonly lastMessage?: string;
    readonly result?: ToolResult;
    readonly appliedFiles?: readonly string[];
};

export type CodingReplayStep =
    | {
          readonly kind: 'run.state';
          readonly eventId: string;
          readonly timestamp: string;
          readonly eventType: AgentEvent['type'];
          readonly command?: NonNullable<AgentEvent['run']>['command'];
          readonly state?: NonNullable<AgentEvent['run']>['state'];
          readonly runId?: string;
          readonly inputId?: string;
          readonly messageId?: string;
          readonly parentMessageId?: string;
          readonly delivery?: NonNullable<AgentEvent['run']>['delivery'];
          readonly providerTurnId?: string;
          readonly toolCallId?: string;
          readonly graphId?: string;
          readonly nodeId?: string;
          readonly reason?: string;
          readonly errorCode?: ProtocolError['code'];
          readonly message?: string;
      }
    | {
          readonly kind: 'provider.tool_call';
          readonly eventId: string;
          readonly timestamp: string;
          readonly taskId?: string;
          readonly toolCallId: string;
          readonly toolName: string;
      }
    | {
          readonly kind: 'provider.message';
          readonly eventId: string;
          readonly timestamp: string;
          readonly providerTurnId?: string;
          readonly messageId: string;
          readonly message: string;
          readonly continuation: boolean;
      }
    | {
          readonly kind: 'provider.failure';
          readonly eventId: string;
          readonly timestamp: string;
          readonly providerTurnId?: string;
          readonly requestId: string;
          readonly error: ProtocolError;
      }
    | {
          readonly kind: 'approval';
          readonly eventId: string;
          readonly timestamp: string;
          readonly approvalId: string;
          readonly state: ApprovalRecord['state'];
          readonly subject: ApprovalSubject;
      }
    | {
          readonly kind: 'tool.result';
          readonly eventId: string;
          readonly timestamp: string;
          readonly toolCallId: string;
          readonly status: ToolResult['status'];
          readonly message?: string;
          readonly output?: string;
          readonly error?: ProtocolError;
          readonly appliedFiles?: readonly string[];
      };

export type SessionReplayProjection = {
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
    readonly events: readonly AgentEvent[];
    readonly snapshot: AgentSnapshot;
    readonly timeline: readonly AbgTimelineEntry[];
    readonly graphSnapshots: readonly AbgGraphSnapshot[];
    readonly branchTree: SessionBranchTree;
    readonly branchSummaries: readonly SessionBranchSummary[];
    readonly approvals: readonly ApprovalProjection[];
    readonly toolOutcomes: readonly ToolOutcomeProjection[];
    readonly codingSteps: readonly CodingReplayStep[];
    readonly diagnostics: readonly ReplayDiagnostic[];
};

export type ReplayDiagnostic =
    | {
          readonly code: 'corrupt_trailing_record';
          readonly lineNumber: number;
          readonly sessionId: string;
      }
    | {
          readonly code: 'missing_provider_continuation';
          readonly eventId: string;
          readonly sessionId: string;
          readonly toolCallId: string;
          readonly toolName: string;
      };

export type JsonlSessionReplayPrefixProjection = {
    readonly projection: SessionReplayProjection;
    readonly diagnostics: readonly ReplayDiagnostic[];
};
