export const sessionLifecycleStatuses = ['idle', 'running', 'awaiting', 'stopped', 'failed'] as const;
export type SessionLifecycleStatus = (typeof sessionLifecycleStatuses)[number];

export const sessionAwaitReasons = ['approval', 'user_input', 'subagent'] as const;
export type SessionAwaitReason = (typeof sessionAwaitReasons)[number];

export const sessionAwaitSourceKinds = ['approval', 'run', 'tool_call', 'job', 'child_session', 'operator'] as const;
export type SessionAwaitSourceKind = (typeof sessionAwaitSourceKinds)[number];

export const sessionAwaitStatuses = ['pending', 'resolved', 'cancelled'] as const;
export type SessionAwaitStatus = (typeof sessionAwaitStatuses)[number];

export const sessionInputDeliveries = ['steer', 'queue'] as const;
export type SessionInputDelivery = (typeof sessionInputDeliveries)[number];

export const sessionInputStatuses = ['pending', 'admitted', 'promoted', 'cancelled'] as const;
export type SessionInputStatus = (typeof sessionInputStatuses)[number];

export const sessionMessageRoles = ['system', 'user', 'assistant', 'tool'] as const;
export type SessionMessageRole = (typeof sessionMessageRoles)[number];

export const sessionPartKinds = ['text', 'tool_call', 'tool_result', 'reasoning', 'file', 'data'] as const;
export type SessionPartKind = (typeof sessionPartKinds)[number];

export const sessionRelationKinds = ['parent_child', 'fork', 'clone', 'compaction', 'import', 'export'] as const;
export type SessionRelationKind = (typeof sessionRelationKinds)[number];

export const missionRunStatuses = ['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export type MissionRunStatus = (typeof missionRunStatuses)[number];

export const approvalStatuses = ['pending', 'approved', 'denied', 'cancelled'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const toolCallStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type ToolCallStatus = (typeof toolCallStatuses)[number];

export const runtimeAgentStatuses = ['idle', 'running', 'parked', 'completed', 'failed', 'cancelled'] as const;
export type RuntimeAgentStatus = (typeof runtimeAgentStatuses)[number];

export const asyncJobStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type AsyncJobStatus = (typeof asyncJobStatuses)[number];
