import type {
    AbgGraphSnapshot,
    AgentEvent,
    AgentEventEnvelope,
    AgentSnapshot,
    ApprovalRecord,
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
};

export type ReplayDiagnostic = {
    readonly code: 'corrupt_trailing_record';
    readonly lineNumber: number;
    readonly sessionId: string;
};

export type JsonlSessionReplayPrefixProjection = {
    readonly projection: SessionReplayProjection;
    readonly diagnostics: readonly ReplayDiagnostic[];
};
